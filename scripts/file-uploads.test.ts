import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  readdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CompositeFilesystem,
  LocalFilesystem,
} from '../apps/server/node_modules/@mastra/core/dist/workspace/index.js';
import { AgentFSFilesystem } from '../apps/server/node_modules/@mastra/agentfs/dist/index.js';
import {
  FILE_UPLOAD_CHUNK_SIZE,
  FILE_UPLOAD_MAX_SIZE,
  fileUploadSchema,
} from '@aime/shared/files';
import type { Auth } from '@aime/auth';
import { FileUploads } from '../apps/server/src/modules/files/uploads.js';
import {
  publishUpload,
  uploadDestination,
} from '../apps/server/src/modules/files/upload-workspace.js';
import { fileRoutes } from '../apps/server/src/modules/files/routes.js';
import { errorHandler } from '../apps/server/src/middleware/error-handler.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import type { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { uploadFile } from '../apps/web/src/components/file-manager/upload.js';
import { createWorkspaceFileClient } from '../apps/web/src/components/file-manager/workspace-client.js';
import { filesApi } from '../apps/web/src/components/file-manager/api.js';

const owner = { userId: 'alice', threadId: 'thread' };
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'upload-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  return root;
}
function session(t: test.TestContext) {
  const uploads = new FileUploads();
  const ids: string[] = [];
  t.after(async () => {
    for (const id of ids)
      await uploads.cancel(owner, id).catch(() => undefined);
  });
  return {
    uploads,
    create: async (path: string, size: number) => {
      const upload = await uploads.create(owner, { path, size });
      ids.push(upload.id);
      return upload;
    },
  };
}

test('binary chunks are ordered, retryable and only published after exact completion', async (t) => {
  const root = await fixture(t);
  const { uploads, create } = session(t);
  const bytes = Buffer.alloc(FILE_UPLOAD_CHUNK_SIZE + 17, 0xa3);
  bytes[bytes.length - 1] = 0x19;
  const { id } = await create('docs/binary.dat', bytes.length);
  await assert.rejects(
    uploads.chunk(owner, id, 8, bytes.subarray(0, 8)),
    /FILE_UPLOAD_CHUNK/,
  );
  const first = bytes.subarray(0, FILE_UPLOAD_CHUNK_SIZE);
  assert.deepEqual(await uploads.chunk(owner, id, 0, first), {
    offset: first.length,
  });
  assert.deepEqual(await uploads.chunk(owner, id, 0, first), {
    offset: first.length,
  });
  await assert.rejects(
    uploads.chunk(owner, id, 0, Buffer.from('changed')),
    /FILE_UPLOAD_CHUNK/,
  );
  await assert.rejects(
    uploads.complete(owner, id, (input, source) =>
      publishUpload(root, input.path, source),
    ),
    /INCOMPLETE/,
  );
  assert.deepEqual(await readdir(join(root, 'docs')), []);
  await uploads.chunk(owner, id, first.length, bytes.subarray(first.length));
  let sourcePath = '';
  const publish = async (input: { path: string }, source: string) => {
    sourcePath = source;
    return publishUpload(root, input.path, source);
  };
  assert.deepEqual(await uploads.complete(owner, id, publish), {
    path: 'docs/binary.dat',
  });
  await uploads.complete(owner, id, async () => {
    assert.fail('completion must be idempotent');
  });
  assert.deepEqual(await readFile(join(root, 'docs/binary.dat')), bytes);
  await assert.rejects(readFile(sourcePath), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(root, 'docs')), ['binary.dat']);
});

test('zero-byte files, cancellation, owner and thread isolation', async (t) => {
  const root = await fixture(t);
  const { uploads, create } = session(t);
  const { id } = await create('empty.txt', 0);
  for (const other of [
    { ...owner, userId: 'bob' },
    { ...owner, threadId: 'elsewhere' },
  ])
    await assert.rejects(
      async () => uploads.complete(other, id, async () => undefined),
      /EXPIRED/,
    );
  await uploads.complete(owner, id, (input, source) =>
    publishUpload(root, input.path, source),
  );
  assert.equal((await readFile(join(root, 'empty.txt'))).length, 0);
  const cancelled = await create('cancelled.txt', 3);
  await uploads.chunk(owner, cancelled.id, 0, Buffer.from('abc'));
  await uploads.cancel(owner, cancelled.id);
  await assert.rejects(
    async () =>
      uploads.complete(owner, cancelled.id, async () => assert.fail()),
    /EXPIRED/,
  );
  assert.deepEqual(await readdir(root), ['docs', 'empty.txt']);
});

test('collisions at start or completion preserve originals; traversal and replaced parents fail', async (t) => {
  const root = await fixture(t);
  const source = join(root, 'source');
  await writeFile(source, 'upload');
  await writeFile(join(root, 'docs/existing'), 'original');
  for (const path of [
    '../escape',
    '/absolute',
    'docs/../file',
    'docs\\file',
    '',
  ])
    await assert.rejects(uploadDestination(root, path), /FILE_INVALID_PATH/);
  await assert.rejects(uploadDestination(root, 'docs/existing'), /FILE_EXISTS/);
  await uploadDestination(root, 'docs/new');
  await writeFile(join(root, 'docs/new'), 'created during upload');
  await assert.rejects(publishUpload(root, 'docs/new', source), /FILE_EXISTS/);
  assert.equal(
    await readFile(join(root, 'docs/new'), 'utf8'),
    'created during upload',
  );
  await mkdir(join(root, 'outside'));
  await mkdir(join(root, 'target'));
  await uploadDestination(root, 'target/secret');
  await rm(join(root, 'target'), { recursive: true });
  await symlink(join(root, 'outside'), join(root, 'target'));
  await assert.rejects(
    publishUpload(root, 'target/secret', source),
    /FILE_SYMLINK/,
  );
  assert.deepEqual(await readdir(join(root, 'outside')), []);
  const outcomes = await Promise.allSettled([
    publishUpload(root, 'docs/race', source),
    publishUpload(root, 'docs/race', source),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    (await readdir(join(root, 'docs'))).some((name) =>
      name.startsWith('.upload-'),
    ),
    false,
  );
});

test('size, chunk, and concurrent session limits reject before publication', async (t) => {
  assert.equal(
    fileUploadSchema.safeParse({
      path: 'large',
      size: FILE_UPLOAD_MAX_SIZE + 1,
    }).success,
    false,
  );
  assert.equal(
    fileUploadSchema.safeParse({ path: 'negative', size: -1 }).success,
    false,
  );
  const { uploads, create } = session(t);
  const sessions = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      create(`file-${i}`, FILE_UPLOAD_CHUNK_SIZE + 10),
    ),
  );
  await assert.rejects(create('over-limit', 1), /FILE_UPLOAD_LIMIT/);
  await assert.rejects(
    uploads.chunk(
      owner,
      sessions[0].id,
      0,
      Buffer.alloc(FILE_UPLOAD_CHUNK_SIZE + 1),
    ),
    /FILE_UPLOAD_CHUNK/,
  );
  await assert.rejects(
    uploads.chunk(owner, sessions[0].id, -1, Buffer.from('x')),
    /FILE_UPLOAD_CHUNK/,
  );
});

test('local and AgentFS composite mounts receive uploads while mount roots remain protected', async (t) => {
  const root = await fixture(t);
  const virtual = new AgentFSFilesystem({ path: join(root, 'virtual.db') });
  const filesystem = new CompositeFilesystem({
    mounts: {
      '/local': new LocalFilesystem({ basePath: join(root, 'docs') }),
      '/virtual': virtual,
    },
  });
  await filesystem.init();
  t.after(() => filesystem.destroy());
  const source = join(root, 'source');
  const bytes = Buffer.alloc(700 * 1024, 0xb7);
  await writeFile(source, bytes);
  for (const path of ['local', 'virtual', 'root-file'])
    await assert.rejects(uploadDestination(filesystem, path), /FILE_FORBIDDEN/);
  for (const mount of ['local', 'virtual']) {
    await filesystem.mkdir(`/${mount}/nested`);
    await publishUpload(filesystem, `${mount}/nested/test.bin`, source);
    assert.deepEqual(
      Buffer.from(await filesystem.readFile(`/${mount}/nested/test.bin`)),
      bytes,
    );
    await assert.rejects(
      publishUpload(filesystem, `${mount}/nested/test.bin`, source),
      /FILE_EXISTS/,
    );
    assert.deepEqual(
      (await filesystem.readdir(`/${mount}/nested`)).map((entry) => entry.name),
      ['test.bin'],
    );
  }
});

test('HTTP upload routes enforce authentication, origin, access per chunk and owner isolation', async (t) => {
  const root = await fixture(t);
  let revoked = false;
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return id ? { user: { id } } : null;
      },
    },
  } as unknown as Auth;
  const service = {
    async getThread(_user: string, id: string) {
      if (revoked || id !== 'shared')
        throw new ThreadError('THREAD_NOT_FOUND', 404);
    },
    async withWorkspaceFiles(
      _user: string,
      _thread: string,
      action: (root: string) => Promise<unknown>,
    ) {
      return action(root);
    },
  } as unknown as ThreadService;
  const origin = 'http://localhost:5173';
  const app = fileRoutes(auth, service, [origin]);
  app.route(
    '/api/threads/:threadId/files',
    fileRoutes(auth, service, [origin]),
  );
  app.onError(errorHandler);
  const base = '/api/threads/shared/files/uploads';
  const headers = {
    Origin: origin,
    'x-test-user': 'alice',
    'Content-Type': 'application/json',
  };
  const create = (path: string, extra: RequestInit = {}) =>
    app.request(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, size: 3 }),
      ...extra,
    });
  assert.equal((await create('docs/auth', { headers: {} })).status, 401);
  assert.equal(
    (
      await create('docs/origin', {
        headers: { ...headers, Origin: 'https://evil.test' },
      })
    ).status,
    403,
  );
  assert.equal((await create('missing/file')).status, 404);
  assert.equal((await create('../escape')).status, 400);
  const response = await create('docs/http.bin');
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const url = `${base}/${id}`;
  t.after(() => app.request(url, { method: 'DELETE', headers }));
  assert.equal(
    (
      await app.request(`${url}?offset=0`, {
        method: 'PUT',
        headers: { ...headers, 'x-test-user': 'bob' },
        body: 'abc',
      })
    ).status,
    404,
  );
  revoked = true;
  assert.equal(
    (
      await app.request(`${url}?offset=0`, {
        method: 'PUT',
        headers,
        body: 'abc',
      })
    ).status,
    404,
  );
  revoked = false;
  assert.equal(
    (
      await app.request(`${url}?offset=0`, {
        method: 'PUT',
        headers,
        body: 'abc',
      })
    ).status,
    200,
  );
  assert.equal(
    (await app.request(`${url}/complete`, { method: 'POST', headers })).status,
    200,
  );
  assert.equal(await readFile(join(root, 'docs/http.bin'), 'utf8'), 'abc');
});

test('browser transport slices bytes, retries a lost chunk response and keeps one thread across navigation', async (t) => {
  const previous = globalThis.fetch;
  const requests: { url: string; method: string }[] = [];
  const chunks: number[] = [];
  const progress: number[] = [];
  let lost = true;
  let captured = '';
  const client = createWorkspaceFileClient({
    ...filesApi,
    upload: (thread, ...args) => {
      captured = thread;
      return uploadFile(thread, ...args);
    },
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/uploads')) {
      client.setThread('new-thread');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        path: 'docs/binary.bin',
        size: 7,
      });
      return Response.json({ id: 'session', chunkSize: 3, offset: 0 });
    }
    if (init?.method === 'PUT') {
      chunks.push((init.body as Blob).size);
      if (lost) {
        lost = false;
        throw new TypeError('Lost response');
      }
      return Response.json({
        offset:
          Number(new URL(url, 'http://test').searchParams.get('offset')) +
          (init.body as Blob).size,
      });
    }
    return Response.json({ path: 'docs/binary.bin' });
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  client.setThread('original');
  await client.upload('docs', new File([new Uint8Array(7)], 'binary.bin'), {
    signal: new AbortController().signal,
    onProgress: (value) => progress.push(value),
    onFinishing() {},
  });
  assert.equal(captured, 'original');
  assert.ok(requests.every(({ url }) => url.includes('/threads/original/')));
  assert.deepEqual(chunks, [3, 3, 3, 1]);
  assert.deepEqual(progress, [42, 85, 99, 100]);
  assert.equal(requests.at(-1)?.method, 'DELETE');
});

test('cancelling after a chunk stops publication and cleans the server session', async (t) => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    if (init?.method === 'POST')
      return Response.json({ id: 'session', chunkSize: 3, offset: 0 });
    if (init?.method === 'PUT') return Response.json({ offset: 3 });
    assert.equal(init?.signal?.aborted, false);
    return Response.json({ cancelled: true });
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  await assert.rejects(
    uploadFile('thread', '', new File(['123456'], 'cancel'), {
      signal: controller.signal,
      onProgress: () => controller.abort(),
      onFinishing: () => assert.fail('cancelled upload must not publish'),
    }),
  );
  assert.deepEqual(methods, ['POST', 'PUT', 'DELETE']);
});
