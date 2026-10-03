import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Auth } from '@aime/auth';
import { createApp } from '../apps/server/src/app.js';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import type { LanguageModelService } from '../apps/server/src/modules/models/language-model.js';
import {
  listFiles,
  mutateFile,
  previewFile,
  TEXT_LIMIT,
} from '../apps/server/src/modules/files/service.js';
import { searchFiles } from '../apps/server/src/modules/files/search.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import {
  renameTabs,
  withinPath,
  validName,
} from '../apps/web/src/components/file-manager/state.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'workspace-files-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src', 'hello.ts'),
    'const greeting = "你好";\n// needle literal .*\n',
  );
  await writeFile(join(root, 'plain'), 'a plain file\nneedle\n');
  return root;
}

test('filesystem CRUD preserves contents and refuses collisions, root deletion, traversal and symlinks', async (t) => {
  const root = await fixture(t);
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), 'workspace-outside-')),
  );
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'private.txt'), 'private');
  await symlink(outside, join(root, 'escape'));
  await symlink(join(root, 'plain'), join(root, 'internal'));
  assert.deepEqual(
    (await listFiles(root, '')).entries.map((entry) => entry.name),
    ['src', 'plain'],
  );
  for (const path of [
    '../private.txt',
    '/etc/passwd',
    'src/../plain',
    'src\\hello.ts',
    'escape/private.txt',
    'internal',
    'plain\0',
  ]) {
    await assert.rejects(previewFile(root, path));
    await assert.rejects(mutateFile(root, { operation: 'delete', path }));
  }
  await assert.rejects(mutateFile(root, { operation: 'delete', path: '' }));
  await assert.rejects(
    mutateFile(root, { operation: 'create', path: 'escape/new', kind: 'file' }),
  );
  await mutateFile(root, {
    operation: 'create',
    path: 'folder',
    kind: 'directory',
  });
  await mutateFile(root, {
    operation: 'create',
    path: 'folder/new.txt',
    kind: 'file',
  });
  await assert.rejects(
    mutateFile(root, { operation: 'create', path: 'plain', kind: 'file' }),
  );
  await assert.rejects(
    mutateFile(root, { operation: 'rename', path: 'plain', name: 'src' }),
  );
  await assert.rejects(
    mutateFile(root, { operation: 'rename', path: 'plain', name: '../new' }),
  );
  await mutateFile(root, { operation: 'rename', path: 'src', name: 'renamed' });
  assert.match((await previewFile(root, 'renamed/hello.ts')).text!, /你好/);
  await mutateFile(root, { operation: 'delete', path: 'renamed' });
  await assert.rejects(previewFile(root, 'renamed/hello.ts'));
  assert.equal(await readFile(join(outside, 'private.txt'), 'utf8'), 'private');
});

test('previews classify text .ts, media and unknown binaries, with bounded UTF-8 reads', async (t) => {
  const root = await fixture(t);
  assert.equal((await previewFile(root, 'src/hello.ts')).kind, 'text');
  await writeFile(join(root, 'recording.mp3'), Buffer.from([0, 1, 2]));
  await writeFile(join(root, 'movie.mp4'), Buffer.from([0, 1, 2]));
  await writeFile(
    join(root, 'image.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  await writeFile(join(root, 'data.bin'), Buffer.from([0, 1, 2]));
  assert.equal((await previewFile(root, 'recording.mp3')).kind, 'audio');
  assert.equal((await previewFile(root, 'movie.mp4')).kind, 'video');
  assert.equal((await previewFile(root, 'image.svg')).kind, 'image');
  assert.equal((await previewFile(root, 'data.bin')).kind, 'binary');
  await writeFile(join(root, 'large.txt'), '你'.repeat(TEXT_LIMIT));
  const preview = await previewFile(root, 'large.txt');
  assert.equal(preview.kind, 'text');
  assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(preview.text!) <= TEXT_LIMIT);
  assert.equal(preview.text!.includes('�'), false);
  await assert.rejects(previewFile(root, 'src'));
});

test('unified name and rg content search find nested matches, treat flags/metacharacters literally, and skip ignored paths', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'secret.txt'), 'needle');
  await writeFile(join(root, '-flags.txt'), '--hello\n你好\n');
  await writeFile(join(root, 'binary.dat'), Buffer.from('needle\x00'));
  const names = await searchFiles(root, 'HELLO.TS');
  assert.deepEqual(
    names.matches.map((entry) => entry.path),
    ['src/hello.ts'],
  );
  const content = await searchFiles(root, 'NEEDLE');
  assert.deepEqual(
    content.matches.map((entry) => `${entry.path}:${entry.line}`).sort(),
    ['plain:2', 'src/hello.ts:2'],
  );
  assert.equal((await searchFiles(root, '.*')).matches.length, 1);
  assert.equal(
    (await searchFiles(root, '--hello')).matches[0].path,
    '-flags.txt',
  );
  assert.equal((await searchFiles(root, '你好')).matches.length, 2);
  await writeFile(join(root, 'needle-name.txt'), 'NEEDLE\n');
  await writeFile(join(root, 'needle-binary.bin'), Buffer.from([0, 1, 2]));
  const combined = await searchFiles(root, 'needle');
  assert.equal(
    combined.matches.filter((match) => match.path === 'needle-name.txt').length,
    1,
  );
  assert.equal(
    combined.matches.find((match) => match.path === 'needle-name.txt')?.line,
    1,
  );
  assert.equal(
    combined.matches.find((match) => match.path === 'needle-binary.bin')?.line,
    undefined,
  );
  assert.ok(
    combined.matches.some((match) => match.path === 'needle-binary.bin'),
  );
  await writeFile(join(root, 'many.txt'), 'needle\n'.repeat(250));
  const limited = await searchFiles(root, 'needle');
  assert.equal(limited.truncated, true);
  assert.equal(limited.matches.length, 200);
});

test('file routes enforce authentication, thread ownership, membership and origin; raw media supports Range', async (t) => {
  const root = await fixture(t);
  const origin = 'http://localhost:5173';
  const { memory } = fakeMemory();
  let member = true;
  const service = new ThreadService(
    memory,
    {
      async validate() {},
      async createWorkspace() {
        return root;
      },
      async execute() {},
    },
    {
      async assertMember(userId: string) {
        if (userId !== 'alice' && !(member && userId === 'bob'))
          throw new ThreadError('PROJECT_NOT_FOUND', 404);
        return { role: 'member' as const };
      },
    },
  );
  t.after(() => service.shutdown());
  const personal = await service.createThread('alice', {
    model: null,
    reasoningEffort: 'auto',
  });
  const shared = await service.createThread('alice', {
    model: null,
    reasoningEffort: 'auto',
    projectId: 'project123456789',
  });
  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const user = headers.get('x-test-user');
        return user ? { user: { id: user }, session: { id: 'test' } } : null;
      },
    },
  } as unknown as Auth;
  const server = createApp(auth, undefined, {
    threads: service,
    models: {} as LanguageModelService,
    webOrigin: origin,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/threads`;
  const url = (id: string, path = '') => `${base}/${id}/files${path}`;
  assert.equal((await fetch(url(personal.id))).status, 401);
  assert.equal(
    (
      await fetch(url(personal.id, '/raw?path=plain'), {
        headers: { 'x-test-user': 'bob' },
      })
    ).status,
    404,
  );
  assert.equal(
    (await fetch(url(shared.id), { headers: { 'x-test-user': 'bob' } })).status,
    200,
  );
  member = false;
  assert.equal(
    (await fetch(url(shared.id), { headers: { 'x-test-user': 'bob' } })).status,
    404,
  );
  const headers = {
    'x-test-user': 'alice',
    'Content-Type': 'application/json',
  };
  assert.equal(
    (
      await fetch(url(personal.id), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operation: 'delete', path: 'plain' }),
      })
    ).status,
    403,
  );
  const searched = await fetch(url(personal.id, '/search?query=needle'), {
    headers,
  });
  assert.equal(searched.status, 200);
  assert.equal((await searched.json()).matches.length, 2);
  const created = await fetch(url(personal.id), {
    method: 'POST',
    headers: { ...headers, origin },
    body: JSON.stringify({
      operation: 'create',
      path: 'api.txt',
      kind: 'file',
    }),
  });
  assert.equal(created.status, 200);
  assert.equal(
    (await fetch(url(personal.id, '/preview?path=..%2Fprivate'), { headers }))
      .status,
    400,
  );
  await writeFile(join(root, 'clip.mp4'), '0123456789');
  const range = await fetch(url(personal.id, '/raw?path=clip.mp4'), {
    headers: { ...headers, Range: 'bytes=2-5' },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '2345');
  assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.match(range.headers.get('content-security-policy')!, /sandbox/);
  await writeFile(join(root, 'active.html'), '<script>alert(1)</script>');
  const html = await fetch(url(personal.id, '/raw?path=active.html'), {
    headers,
  });
  assert.match(html.headers.get('content-disposition')!, /^attachment/);
  assert.match(html.headers.get('content-type')!, /^text\/plain/);
});

test('renaming a directory updates descendant tabs without touching similar prefixes', () => {
  const tabs = [{ path: 'src/a.ts', line: 3 }, { path: 'src-old/b.ts' }];
  assert.deepEqual(renameTabs(tabs, 'src', 'lib'), [
    { path: 'lib/a.ts', line: 3 },
    { path: 'src-old/b.ts' },
  ]);
  assert.equal(withinPath('src-old/b.ts', 'src'), false);
  for (const name of ['..', '.', 'a/b', 'a\\b', '', '  ', 'a\0'])
    assert.equal(validName(name), false);
  assert.equal(validName('中文 file.ts'), true);
});
