import { openSessionStub } from './fixtures/thread-session.js';
import { createNodeServer } from '../apps/server/src/server.js';
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
  stat,
  readdir,
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
import {
  AgentFSMounts,
  createProjectFilesystem,
  createProjectWorkspace,
  getWorkspace,
} from '../apps/server/src/modules/threads/workspace.js';
import {
  defaultProjectWorkspace,
  projectCreateSchema,
  projectWorkspaceSchema,
  type ProjectWorkspace,
} from '@aime/shared/projects';
import {
  listWorkspaceFiles,
  mutateWorkspaceFile,
  previewWorkspaceFile,
  searchWorkspaceFiles,
} from '../apps/server/src/modules/files/workspace-files.js';
import { searchFiles } from '../apps/server/src/modules/files/search.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import {
  renameTabs,
  withinPath,
  validName,
} from '../apps/web/src/components/file-manager/state.js';

async function fixture(
  t: test.TestContext,
  beforeRemove?: () => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'workspace-files-')),
  );
  t.after(async () => {
    await beforeRemove?.();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src', 'hello.ts'),
    'const greeting = "你好";\n// needle literal .*\n',
  );
  await writeFile(join(root, 'plain'), 'a plain file\nneedle\n');
  await writeFile(join(root, '._plain'), 'needle in macOS metadata');
  await writeFile(join(root, 'src', '._hello.ts'), 'needle in macOS metadata');
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

test('file listings and search hide macOS metadata while preserving ordinary dotfiles and disk contents', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, '.gitignore'), 'node_modules');
  await mkdir(join(root, '._metadata'));
  await writeFile(join(root, '._metadata', 'needle.txt'), 'needle');
  const listing = await listWorkspaceFiles(root, '');
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ['src', '.gitignore', 'plain'],
  );
  assert.equal(listing.truncated, false);
  assert.deepEqual(
    (await listWorkspaceFiles(root, 'src')).entries.map((entry) => entry.name),
    ['hello.ts'],
  );
  assert.deepEqual((await searchFiles(root, '._')).matches, []);
  assert.deepEqual(
    (await searchFiles(root, 'needle')).matches.map((entry) => entry.path),
    ['plain', 'src/hello.ts'],
  );
  assert.equal(
    (await searchFiles(root, '.gitignore')).matches[0]?.path,
    '.gitignore',
  );
  assert.equal(
    await readFile(join(root, '._plain'), 'utf8'),
    'needle in macOS metadata',
  );
});

test('composite listings identify only mount roots and protect them while allowing child mutations', async (t) => {
  const root = await fixture(t);
  const directory = await createProjectWorkspace(root, 'project123456789');
  const filesystem = createProjectFilesystem(directory, {
    mode: 'composite',
    mounts: [
      { provider: 'local', mountPath: 'local' },
      { provider: 'local', mountPath: 'data' },
    ],
  });
  await filesystem.init?.();
  t.after(() => filesystem.destroy?.());
  assert.deepEqual((await listWorkspaceFiles(filesystem, '')).entries, [
    { name: 'data', path: 'data', kind: 'directory', isMount: true },
    { name: 'local', path: 'local', kind: 'directory', isMount: true },
  ]);
  for (const mount of ['local', 'data']) {
    await filesystem.mkdir(`/${mount}/docs`);
    await filesystem.writeFile(`/${mount}/._docs`, 'macOS metadata');
    assert.deepEqual((await listWorkspaceFiles(filesystem, mount)).entries, [
      { name: 'docs', path: `${mount}/docs`, kind: 'directory' },
    ]);
    await assert.rejects(
      async () =>
        mutateWorkspaceFile(filesystem, { operation: 'delete', path: mount }),
      /FILE_FORBIDDEN/,
    );
    await assert.rejects(
      async () =>
        mutateWorkspaceFile(filesystem, {
          operation: 'rename',
          path: mount,
          name: 'moved',
        }),
      /FILE_FORBIDDEN/,
    );
    await mutateWorkspaceFile(filesystem, {
      operation: 'rename',
      path: `${mount}/docs`,
      name: 'renamed',
    });
    await mutateWorkspaceFile(filesystem, {
      operation: 'delete',
      path: `${mount}/renamed`,
    });
    assert.deepEqual((await listWorkspaceFiles(filesystem, mount)).entries, []);
  }
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
  const mounts = new AgentFSMounts();
  const root = await fixture(t, () => mounts.dispose());
  const agentDirectory = join(root, 'agent');
  t.after(() => mounts.dispose());
  const origin = 'http://localhost:5173';
  const { memory } = fakeMemory();
  let member = true;
  let projectProvider: 'local' | 'agentfs' = 'local';
  const service = new ThreadService(
    memory,
    {
      async validate() {},
      async projectFilesystem() {
        return createProjectFilesystem(
          projectProvider === 'agentfs' ? agentDirectory : root,
          {
            mode: 'simple',
            provider: projectProvider,
          },
          mounts,
        );
      },
      async createWorkspace() {
        return root;
      },
      open: openSessionStub,
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
  const server = createNodeServer(
    createApp(auth, undefined, {
      threads: service,
      models: {} as LanguageModelService,
      webOrigin: origin,
    }),
  ).listen(0, '127.0.0.1');
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
  if (process.env.TEST_AGENTFS_MOUNT !== '1') {
    t.diagnostic('Native AgentFS HTTP checks require TEST_AGENTFS_MOUNT=1');
    return;
  }
  projectProvider = 'agentfs';
  const filesystem = createProjectFilesystem(
    agentDirectory,
    {
      mode: 'simple',
      provider: 'agentfs',
    },
    mounts,
  );
  await filesystem.init?.();
  await filesystem.writeFile('virtual.txt', 'AgentFS HTTP content');
  await filesystem.writeFile('clip.mp4', '0123456789');
  await filesystem.destroy?.();
  const preview = await fetch(url(shared.id, '/preview?path=virtual.txt'), {
    headers,
  });
  assert.equal((await preview.json()).text, 'AgentFS HTTP content');
  const virtualRaw = await fetch(url(shared.id, '/raw?path=virtual.txt'), {
    headers,
  });
  assert.equal(virtualRaw.status, 200);
  assert.match(virtualRaw.headers.get('content-type')!, /^text\/plain/);
  assert.match(virtualRaw.headers.get('content-disposition')!, /^attachment/);
  assert.equal(await virtualRaw.text(), 'AgentFS HTTP content');
  const virtualMissing = await fetch(url(shared.id, '/raw?path=missing'), {
    headers,
  });
  assert.equal(virtualMissing.status, 404);
  const virtualRange = await fetch(url(shared.id, '/raw?path=clip.mp4'), {
    headers: { ...headers, Range: 'bytes=2-5' },
  });
  assert.equal(virtualRange.status, 206);
  assert.equal(await virtualRange.text(), '2345');
  assert.equal(virtualRange.headers.get('content-range'), 'bytes 2-5/10');
  await mounts.dispose();
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

const projectId = 'project123456789';
const nativeMounts = process.env.TEST_AGENTFS_MOUNT === '1';

test('concurrent filesystem instances share one mount until server shutdown and reject lost mounts', async () => {
  let started = 0;
  let stopped = 0;
  let alive = true;
  const mounts = new AgentFSMounts(async () => {
    started++;
    await new Promise<void>((done) => setImmediate(done));
    return {
      alive: () => alive,
      async stop() {
        stopped++;
      },
    };
  });
  await Promise.all(
    Array.from({ length: 8 }, () =>
      mounts.ensure('/workspace/project', '/workspace/project.db'),
    ),
  );
  assert.equal(started, 1);
  await assert.rejects(
    () => mounts.ensure('/workspace/project', '/workspace/other.db'),
    /another database/,
  );
  alive = false;
  await assert.rejects(
    () => mounts.ensure('/workspace/project', '/workspace/project.db'),
    /stopped unexpectedly/,
  );
  await mounts.dispose();
  assert.equal(stopped, 1);
  await assert.rejects(
    () => mounts.ensure('/workspace/other', '/workspace/other.db'),
    /shutting down/,
  );
});

test('failed mount startup is retryable and shutdown waits for in-flight startup', async () => {
  let starts = 0;
  let stops = 0;
  const mounts = new AgentFSMounts(async () => {
    if (++starts === 1) throw new Error('startup failed');
    await new Promise<void>((done) => setImmediate(done));
    return {
      alive: () => true,
      async stop() {
        stops++;
      },
    };
  });
  await assert.rejects(
    () => mounts.ensure('/workspace/project', '/workspace/project.db'),
    /startup failed/,
  );
  const ready = mounts.ensure('/workspace/project', '/workspace/project.db');
  await Promise.all([ready, mounts.dispose()]);
  assert.equal(starts, 2);
  assert.equal(stops, 1);
});

test('composite initialization propagates a failed mount before any file or terminal access', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'project-failed-mount-')),
  );
  const mounts = new AgentFSMounts(async () => {
    throw new Error('mount unavailable');
  });
  t.after(async () => {
    await mounts.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const filesystem = createProjectFilesystem(
    root,
    {
      mode: 'composite',
      mounts: [
        { provider: 'local', mountPath: 'local' },
        { provider: 'agentfs', mountPath: 'data' },
      ],
    },
    mounts,
  );
  await assert.rejects(async () => filesystem.init!(), /mount unavailable/);
  assert.equal(filesystem.status, 'error');
  assert.deepEqual(await readdir(root), ['local']);
});

test(
  'native mounting refuses to hide existing files',
  { skip: !nativeMounts },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'project-nonempty-')),
    );
    const mounts = new AgentFSMounts();
    t.after(async () => {
      await mounts.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const directory = join(root, projectId);
    await mkdir(directory);
    await writeFile(join(directory, 'keep.txt'), 'keep');
    await assert.rejects(
      () => mounts.ensure(directory, `${directory}.db`),
      /must be empty/,
    );
    assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'keep');
  },
);

test('project configuration defaults to automatic local storage and validates composite paths', () => {
  assert.deepEqual(projectCreateSchema.parse({ name: ' Demo ' }), {
    name: 'Demo',
    workspace: defaultProjectWorkspace,
  });
  for (const provider of ['local', 'agentfs']) {
    assert.ok(
      projectWorkspaceSchema.safeParse({ mode: 'simple', provider }).success,
    );
    assert.equal(
      projectWorkspaceSchema.safeParse({
        mode: 'simple',
        provider,
        path: '/custom',
      }).success,
      false,
    );
  }
  const mount = { provider: 'local', mountPath: 'local' };
  for (const mounts of [
    [],
    [{ ...mount, path: '' }],
    [{ ...mount, path: '../escape' }],
    [{ ...mount, mountPath: '/' }],
    [{ ...mount, mountPath: '' }],
    [{ ...mount, mountPath: 'a\\b' }],
    [{ ...mount, mountPath: '..' }],
    [{ ...mount, mountPath: 'a'.repeat(65) }],
    [mount, { ...mount, mountPath: 'LOCAL' }],
    [{ ...mount, mountPath: '/data/../escape' }],
    [mount, mount],
    [mount, { ...mount, mountPath: '/data/nested' }],
    [{ ...mount, mountPath: '/data/nested' }, mount],
  ]) {
    assert.equal(
      projectWorkspaceSchema.safeParse({ mode: 'composite', mounts }).success,
      false,
      JSON.stringify(mounts),
    );
  }
  assert.ok(
    projectWorkspaceSchema.safeParse({
      mode: 'composite',
      mounts: [
        mount,
        {
          provider: 'agentfs',
          mountPath: 'archive',
        },
      ],
    }).success,
  );
});

for (const provider of ['local', 'agentfs'] as const)
  test(
    `automatic ${provider} storage persists files and stays shared across project conversations`,
    { skip: provider === 'agentfs' && !nativeMounts },
    async (t) => {
      const mounts = new AgentFSMounts();
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'project-storage-')),
      );
      t.after(async () => {
        await mounts.dispose();
        await rm(root, { recursive: true, force: true });
      });
      const directory = await createProjectWorkspace(root, projectId);
      assert.equal(directory, join(root, 'projects', projectId));
      const config = { mode: 'simple', provider } as const;
      const filesystem = createProjectFilesystem(directory, config, mounts);
      const workspace = getWorkspace(
        root,
        'alice',
        directory,
        projectId,
        [],
        filesystem,
      );
      await workspace.init();
      try {
        await filesystem.writeFile('shared.txt', 'Shared project files');
        assert.equal(
          await readFile(join(directory, 'shared.txt'), 'utf8'),
          'Shared project files',
        );
        const command = await workspace.sandbox!.executeCommand!('sh', [
          '-c',
          'cat shared.txt; printf terminal > from-terminal.txt',
        ]);
        assert.equal(command.exitCode, 0);
        assert.equal(command.stdout, 'Shared project files');
        assert.equal(
          String(await filesystem.readFile('from-terminal.txt')),
          'terminal',
        );
        assert.equal(
          (await previewWorkspaceFile(filesystem, 'shared.txt')).text,
          'Shared project files',
        );
      } finally {
        await workspace.destroy();
      }
      const reopened = createProjectFilesystem(directory, config, mounts);
      await reopened.init?.();
      try {
        assert.equal(
          String(await reopened.readFile('shared.txt')),
          'Shared project files',
        );
        assert.deepEqual(
          (await listWorkspaceFiles(reopened, '')).entries.map(
            (entry) => entry.name,
          ),
          ['from-terminal.txt', 'shared.txt'],
        );
        if (provider === 'agentfs')
          assert.ok((await readFile(`${directory}.db`)).length > 0);
      } finally {
        await reopened.destroy?.();
      }
      await mounts.dispose();
      if (provider === 'agentfs') {
        assert.deepEqual(await readdir(directory), []);
        const nextMounts = new AgentFSMounts();
        t.after(() => nextMounts.dispose());
        const fresh = createProjectFilesystem(directory, config, nextMounts);
        try {
          await fresh.init?.();
          assert.equal(
            String(await fresh.readFile('from-terminal.txt')),
            'terminal',
          );
        } finally {
          await fresh.destroy?.();
          await nextMounts.dispose();
        }
      }
    },
  );

test(
  'manual composition shares native local and AgentFS directories with the terminal and file manager',
  { skip: !nativeMounts },
  async (t) => {
    const mounts = new AgentFSMounts();
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'project-composite-')),
    );
    t.after(async () => {
      await mounts.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const directory = await createProjectWorkspace(root, projectId);
    const config: ProjectWorkspace = {
      mode: 'composite',
      mounts: [
        { provider: 'local', mountPath: 'local' },
        { provider: 'agentfs', mountPath: 'archive' },
      ],
    };
    const filesystem = createProjectFilesystem(directory, config, mounts);
    await filesystem.init?.();
    t.after(() => filesystem.destroy?.());
    assert.deepEqual(
      (await listWorkspaceFiles(filesystem, '')).entries.map((entry) => ({
        path: entry.path,
        isMount: entry.isMount,
      })),
      [
        { path: 'archive', isMount: true },
        { path: 'local', isMount: true },
      ],
    );
    for (const mount of ['local', 'archive']) {
      await mutateWorkspaceFile(filesystem, {
        operation: 'create',
        path: `${mount}/docs`,
        kind: 'directory',
      });
      await mutateWorkspaceFile(filesystem, {
        operation: 'create',
        path: `${mount}/docs/test.txt`,
        kind: 'file',
      });
      await filesystem.writeFile(
        `/${mount}/docs/test.txt`,
        'needle in shared files',
      );
      assert.equal(
        (await previewWorkspaceFile(filesystem, `${mount}/docs/test.txt`)).text,
        'needle in shared files',
      );
      assert.deepEqual(
        await mutateWorkspaceFile(filesystem, {
          operation: 'rename',
          path: `${mount}/docs/test.txt`,
          name: 'renamed.txt',
        }),
        { path: `${mount}/docs/renamed.txt` },
      );
      await assert.rejects(async () =>
        mutateWorkspaceFile(filesystem, {
          operation: 'create',
          path: `${mount}/docs/renamed.txt`,
          kind: 'file',
        }),
      );
      await assert.rejects(
        async () =>
          mutateWorkspaceFile(filesystem, { operation: 'delete', path: mount }),
        /FILE_FORBIDDEN/,
      );
      await assert.rejects(
        async () =>
          mutateWorkspaceFile(filesystem, {
            operation: 'rename',
            path: mount,
            name: 'moved',
          }),
        /FILE_FORBIDDEN/,
      );
      await assert.rejects(
        async () => previewWorkspaceFile(filesystem, `${mount}/../outside`),
        /FILE_INVALID_PATH/,
      );
    }
    assert.equal(
      await readFile(join(directory, 'local/docs/renamed.txt'), 'utf8'),
      'needle in shared files',
    );
    assert.deepEqual(
      (await searchWorkspaceFiles(filesystem, 'NEEDLE')).matches.map(
        (entry) => entry.path,
      ),
      ['archive/docs/renamed.txt', 'local/docs/renamed.txt'],
    );
    const workspace = getWorkspace(
      root,
      'alice',
      directory,
      projectId,
      [],
      filesystem,
    );
    await workspace.init();
    try {
      const result = await workspace.sandbox!.executeCommand!('sh', [
        '-c',
        'cat archive/docs/renamed.txt; printf native > local/terminal.txt; printf mounted > archive/terminal.txt',
      ]);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, 'needle in shared files');
      assert.equal(
        String(await filesystem.readFile('/local/terminal.txt')),
        'native',
      );
      assert.equal(
        String(await filesystem.readFile('/archive/terminal.txt')),
        'mounted',
      );
    } finally {
      await workspace.destroy();
    }
    // A request closing its workspace does not unmount storage used by another request.
    await filesystem.init?.();
    assert.notEqual(
      (await stat(join(directory, 'archive'))).dev,
      (await stat(directory)).dev,
    );
    assert.ok((await stat(`${directory}-archive.db`)).isFile());
    await filesystem.writeFile('/archive/large.txt', 'a'.repeat(600 * 1024));
    const preview = await previewWorkspaceFile(filesystem, 'archive/large.txt');
    assert.equal(preview.text?.length, 512 * 1024);
    assert.equal(preview.truncated, true);
    await writeFile(join(root, 'outside.txt'), 'secret');
    await symlink(join(root, 'outside.txt'), join(directory, 'local/link.txt'));
    await assert.rejects(
      () => previewWorkspaceFile(filesystem, 'local/link.txt'),
      /FILE_SYMLINK/,
    );
    assert.equal(
      (await listWorkspaceFiles(filesystem, 'local')).entries.some(
        (entry) => entry.name === 'link.txt',
      ),
      false,
    );
    await mutateWorkspaceFile(filesystem, {
      operation: 'delete',
      path: 'archive/docs',
    });
    assert.equal(await filesystem.exists('/archive/docs'), false);
  },
);

test('project file access checks membership before opening storage and closes it on failure', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-access-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { memory } = fakeMemory();
  let opened = 0;
  let closed = 0;
  const service = new ThreadService(
    memory,
    {
      async createWorkspace() {
        return root;
      },
      async validate() {},
      open: openSessionStub,
      async projectFilesystem() {
        opened++;
        const filesystem = createProjectFilesystem(
          root,
          defaultProjectWorkspace,
        );
        const destroy = filesystem.destroy?.bind(filesystem);
        filesystem.destroy = async () => {
          closed++;
          await destroy?.();
        };
        return filesystem;
      },
    },
    {
      async assertMember(userId) {
        if (userId !== 'alice') throw new Error('PROJECT_NOT_FOUND');
        return { role: 'owner' };
      },
    },
  );
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', {
    projectId,
    model: null,
    reasoningEffort: 'auto',
  });
  await assert.rejects(
    () =>
      service.withWorkspaceFiles('outsider', thread.id, async () => undefined),
    /PROJECT_NOT_FOUND/,
  );
  assert.equal(opened, 0);
  await assert.rejects(
    () =>
      service.withWorkspaceFiles('alice', thread.id, async () => {
        throw new Error('operation failed');
      }),
    /operation failed/,
  );
  assert.equal(opened, 1);
  assert.equal(closed, 1);
});

test('project creation uses projects without moving previous storage', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-layout-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = join(root, projectId);
  await mkdir(previous);
  await writeFile(join(previous, 'keep.txt'), 'old directory');
  await writeFile(`${previous}.db`, 'old database');
  const directory = await createProjectWorkspace(root, projectId);
  assert.equal(directory, join(root, 'projects', projectId));
  assert.equal(await createProjectWorkspace(root, projectId), directory);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(
    await readFile(join(previous, 'keep.txt'), 'utf8'),
    'old directory',
  );
  assert.equal(await readFile(`${previous}.db`, 'utf8'), 'old database');
  await assert.rejects(() => stat(`${directory}.db`), { code: 'ENOENT' });
});
