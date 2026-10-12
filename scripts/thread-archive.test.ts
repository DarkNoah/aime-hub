import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  realpath,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ThreadNavigationEvent } from '@aime/shared/threads';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import {
  createPersonalWorkspace,
  removePersonalWorkspace,
  userDirectory,
} from '../apps/server/src/modules/threads/workspace.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { openSessionStub } from './fixtures/thread-session.js';
import { createApp } from '../apps/server/src/app.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';
import type { LanguageModelService } from '../apps/server/src/modules/models/language-model.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;

test('archive RPC endpoints enforce sessions and origins and complete the archive/restore/delete lifecycle', async (t) => {
  const { service, thread, directory, threads } = await fixture(t);
  const origin = 'http://localhost:5173';
  let userId: string | undefined = 'alice';
  let requestOrigin = origin;
  const auth = {
    api: {
      getSession: async () =>
        userId ? { user: { id: userId, role: 'user' } } : null,
    },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, {
    threads: service,
    models: {
      async getPreferences() {
        return settings;
      },
    } as unknown as LanguageModelService,
    webOrigin: origin,
  });
  const client = createApiClient(() => `${origin}/api/rpc`);
  t.mock.method(globalThis, 'fetch', (request: Request) => {
    const headers = new Headers(request.headers);
    headers.set('origin', requestOrigin);
    return app.request(new Request(request, { headers }));
  });
  const params = { threadId: thread.id };
  assert.deepEqual(await client.threads.archived(), []);
  requestOrigin = 'https://untrusted.example';
  await assert.rejects(client.threads.remove({ params }), {
    code: 'FORBIDDEN',
  });
  requestOrigin = origin;
  await client.threads.remove({ params });
  assert.equal((await client.threads.archived())[0].id, thread.id);
  userId = undefined;
  await assert.rejects(client.threads.archived(), { code: 'UNAUTHORIZED' });
  userId = 'bob';
  assert.deepEqual(await client.threads.archived(), []);
  await assert.rejects(client.threads.restore({ params }), {
    code: 'THREAD_NOT_FOUND',
  });
  await assert.rejects(client.threads.removeArchived({ params }), {
    code: 'THREAD_NOT_FOUND',
  });
  userId = 'alice';
  requestOrigin = 'https://untrusted.example';
  await assert.rejects(client.threads.restore({ params }), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(client.threads.removeArchived({ params }), {
    code: 'FORBIDDEN',
  });
  requestOrigin = origin;
  await client.threads.restore({ params });
  assert.equal((await client.threads.get({ params })).thread.id, thread.id);
  await client.threads.remove({ params });
  await client.threads.removeArchived({ params });
  assert.deepEqual(await client.threads.archived(), []);
  assert.equal(threads.has(thread.id), false);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp('/tmp/thread-archive-'));
  const store = fakeMemory();
  const runner = {
    async validate() {},
    createWorkspace: (userId: string) => createPersonalWorkspace(root, userId),
    removePersonalWorkspace: (userId: string, directory: string) =>
      removePersonalWorkspace(root, userId, directory),
    open: openSessionStub,
  };
  const service = new ThreadService(store.memory, runner, {
    async assertMember() {
      return { role: 'owner' };
    },
  });
  t.after(async () => {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const thread = await service.createThread('alice', {
    ...settings,
    title: 'Keep this chat',
  });
  const directory = await service.workspaceDirectory('alice', thread.id);
  await writeFile(join(directory, 'notes.txt'), 'Keep these notes');
  await store.memory.saveMessages({
    messages: [
      {
        id: 'message-1',
        role: 'user',
        threadId: thread.id,
        resourceId: 'user:alice',
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: 'text', text: 'Remember me' }] },
      },
    ],
  });
  return { ...store, root, runner, service, thread, directory };
}

test('archive preserves messages, metadata and files across service restart, and restore returns the original chat', async (t) => {
  const { memory, messages, threads, runner, service, thread, directory } =
    await fixture(t);
  await memory.updateThread({
    id: thread.id,
    title: thread.title,
    metadata: { custom: 'preserved', workingMemory: 'notes' },
  });
  await service.deleteThread('alice', thread.id);
  assert.equal(threads.size, 1);
  assert.equal(messages.size, 1);
  assert.equal(
    await readFile(join(directory, 'notes.txt'), 'utf8'),
    'Keep these notes',
  );
  assert.equal((await service.listThreads('alice')).threads.length, 0);
  const [archived] = await service.listArchivedThreads('alice');
  assert.equal(archived.id, thread.id);
  assert.ok(archived.archivedAt);
  await service.deleteThread('alice', thread.id);
  assert.equal(
    (await service.listArchivedThreads('alice'))[0].archivedAt,
    archived.archivedAt,
  );
  await service.shutdown();
  const restarted = new ThreadService(memory, runner);
  t.after(() => restarted.shutdown());
  assert.equal((await restarted.listArchivedThreads('alice'))[0].id, thread.id);
  await restarted.restoreThread('alice', thread.id);
  assert.equal((await restarted.listArchivedThreads('alice')).length, 0);
  const restored = await restarted.getThread('alice', thread.id);
  assert.equal(restored.thread.title, thread.title);
  assert.equal(restored.messages[0].id, 'message-1');
  assert.equal(threads.get(thread.id)?.metadata?.custom, 'preserved');
  assert.equal(
    await restarted.workspaceDirectory('alice', thread.id),
    directory,
  );
});

test('archives reject normal access and unauthorized restore or deletion', async (t) => {
  const { service, thread, threads } = await fixture(t);
  await assert.rejects(service.deleteArchivedThread('alice', thread.id), {
    code: 'THREAD_NOT_ARCHIVED',
  });
  await service.deleteThread('alice', thread.id);
  for (const user of ['alice', 'bob']) {
    for (const action of [
      () => service.getThread(user, thread.id),
      () => service.history(user, thread.id),
      () => service.workspaceDirectory(user, thread.id),
      () =>
        service.withWorkspaceFiles(user, thread.id, async () =>
          assert.fail('Archived files exposed'),
        ),
      () => service.updateThread(user, thread.id, { title: 'Changed' }),
      () =>
        service.run(user, thread.id, {
          ...settings,
          id: 'new-input',
          isImmediate: false,
          parts: [{ type: 'text', text: 'run' }],
        }),
      () => service.subscribe(user, thread.id, () => {}),
    ])
      await assert.rejects(action, { code: 'THREAD_NOT_FOUND' });
  }
  await assert.rejects(service.restoreThread('bob', thread.id), {
    code: 'THREAD_NOT_FOUND',
  });
  await assert.rejects(service.deleteArchivedThread('bob', thread.id), {
    code: 'THREAD_NOT_FOUND',
  });
  assert.deepEqual(await service.listArchivedThreads('bob'), []);
  assert.equal(threads.size, 1);
});

test('permanent deletion removes only the archived chat and its own folder', async (t) => {
  const { root, service, thread, directory, messages, threads } =
    await fixture(t);
  const sibling = await service.createThread('alice', settings);
  const siblingDirectory = await service.workspaceDirectory(
    'alice',
    sibling.id,
  );
  const skills = join(userDirectory(root, 'alice'), '.agents', 'skills');
  const projectDirectory = join(root, 'projects', 'shared');
  await mkdir(skills, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });
  await service.deleteThread('alice', thread.id);
  await service.deleteArchivedThread('alice', thread.id);
  assert.equal(threads.has(thread.id), false);
  assert.equal(messages.size, 0);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  for (const path of [siblingDirectory, skills, projectDirectory])
    assert.ok((await stat(path)).isDirectory());
  assert.equal((await service.listThreads('alice')).threads[0].id, sibling.id);
});

test('filesystem failure retains the archive; missing folder and a database failure can be retried', async (t) => {
  const { service, runner, thread, directory, memory, threads } =
    await fixture(t);
  await service.deleteThread('alice', thread.id);
  const cleanup = t.mock.method(runner, 'removePersonalWorkspace', async () => {
    throw new Error('Filesystem unavailable');
  });
  await assert.rejects(
    service.deleteArchivedThread('alice', thread.id),
    /Filesystem unavailable/,
  );
  assert.ok(threads.has(thread.id));
  assert.ok(await stat(directory));
  cleanup.mock.restore();
  const deletion = t.mock.method(memory, 'deleteThread', async () => {
    throw new Error('Database unavailable');
  });
  await assert.rejects(
    service.deleteArchivedThread('alice', thread.id),
    /Database unavailable/,
  );
  assert.ok(threads.has(thread.id));
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  deletion.mock.restore();
  await service.deleteArchivedThread('alice', thread.id);
  assert.equal(threads.has(thread.id), false);
});

test('archive filtering happens before pagination and excludes judges and other owners', async (t) => {
  const { service, memory, thread } = await fixture(t);
  await service.deleteThread('alice', thread.id);
  const visible: string[] = [];
  for (let i = 0; i < 23; i++) {
    const chat = await service.createThread('alice', settings);
    visible.push(chat.id);
    await memory.createThread({
      threadId: `archived-${i}`,
      resourceId: 'user:alice',
      metadata: { archivedAt: new Date().toISOString() },
    });
  }
  await memory.createThread({
    threadId: 'judge',
    resourceId: 'user:alice',
    metadata: { archivedAt: new Date().toISOString(), goalJudge: false },
  });
  await memory.createThread({
    threadId: 'other',
    resourceId: 'user:bob',
    metadata: { archivedAt: new Date().toISOString() },
  });
  const pages = await Promise.all(
    [0, 1, 2].map((page) => service.listThreads('alice', page)),
  );
  assert.deepEqual(
    pages.map((page) => page.threads.length),
    [10, 10, 3],
  );
  assert.deepEqual(
    pages.map((page) => page.hasMore),
    [true, true, false],
  );
  assert.deepEqual(
    pages.flatMap((page) => page.threads.map((thread) => thread.id)),
    visible,
  );
  assert.equal((await service.listArchivedThreads('alice')).length, 24);
});

test('archive revokes an open stream, disappears from navigation and restoration publishes it again', async (t) => {
  const { service, thread } = await fixture(t);
  const events: ThreadNavigationEvent[] = [];
  const revoked: (string | undefined)[] = [];
  await service.subscribe(
    'alice',
    thread.id,
    () => {},
    (code) => revoked.push(code),
  );
  service.subscribeNavigation(
    'alice',
    (event) => events.push(event),
    () => {},
  );
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await delay(5);
    }
    assert.fail('Navigation did not update');
  };
  await until(() => events.length > 0);
  await service.deleteThread('alice', thread.id);
  await until(() => events.some((event) => event.type === 'remove'));
  assert.deepEqual(revoked, ['THREAD_NOT_FOUND']);
  service.refreshNavigation('alice');
  await until(
    () => events.filter((event) => event.type === 'snapshot').length === 2,
  );
  const snapshot = events.at(-1)!;
  assert.equal(snapshot.type, 'snapshot');
  if (snapshot.type === 'snapshot') assert.deepEqual(snapshot.threads, []);
  if (snapshot.type === 'snapshot')
    assert.equal(snapshot.archivedThreads?.[0].id, thread.id);
  await service.restoreThread('alice', thread.id);
  await until(() =>
    events.some(
      (event) => event.type === 'upsert' && event.thread.id === thread.id,
    ),
  );
  await service.deleteThread('alice', thread.id);
  await until(
    () => events.filter((event) => event.type === 'remove').length === 2,
  );
  const removed = events.at(-1)!;
  assert.ok(
    removed.type === 'remove' && removed.archivedThread?.id === thread.id,
  );
  await service.deleteArchivedThread('alice', thread.id);
  await until(
    () => events.filter((event) => event.type === 'remove').length === 3,
  );
  const deleted = events.at(-1)!;
  assert.ok(deleted.type === 'remove' && !deleted.archivedThread);
});

test('project chat deletion retains its existing behavior and cannot use personal archive endpoints', async (t) => {
  const { service, memory, threads, root } = await fixture(t);
  const path = join(root, 'projects', 'shared');
  await mkdir(path, { recursive: true });
  await memory.createThread({
    threadId: 'project-chat',
    resourceId: 'project:project123456789',
    metadata: { workspace: path },
  });
  await assert.rejects(service.restoreThread('alice', 'project-chat'), {
    code: 'THREAD_NOT_FOUND',
  });
  await assert.rejects(service.deleteArchivedThread('alice', 'project-chat'), {
    code: 'THREAD_NOT_FOUND',
  });
  await service.deleteThread('alice', 'project-chat');
  assert.equal(threads.has('project-chat'), false);
  assert.ok(await stat(path));
});

test('workspace cleanup rejects parent, sibling, traversal and symlink destinations', async (t) => {
  const { root, directory } = await fixture(t);
  const owner = userDirectory(root, 'alice');
  const other = await createPersonalWorkspace(root, 'bob');
  const shared = join(owner, '.agents');
  await mkdir(shared);
  for (const path of [
    root,
    owner,
    other,
    shared,
    `${directory}/../${directory.split('/').at(-1)}`,
    'relative',
  ])
    await assert.rejects(removePersonalWorkspace(root, 'alice', path), {
      code: 'WORKSPACE_UNAVAILABLE',
    });
  const link = join(owner, '2026-10-10-link01');
  await symlink(other, link);
  await assert.rejects(removePersonalWorkspace(root, 'alice', link), {
    code: 'WORKSPACE_UNAVAILABLE',
  });
  await symlink(other, join(directory, 'external'));
  await removePersonalWorkspace(root, 'alice', directory);
  assert.ok(await stat(other));
  await rm(owner, { recursive: true, force: true });
  await symlink(userDirectory(root, 'bob'), owner);
  await assert.rejects(
    removePersonalWorkspace(
      root,
      'alice',
      join(owner, other.split('/').at(-1)!),
    ),
    { code: 'WORKSPACE_UNAVAILABLE' },
  );
  assert.ok(await stat(other));
});

test('archiving waits for an in-flight personal file mutation before hiding access', async (t) => {
  const { service, thread, directory } = await fixture(t);
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const write = service.withWorkspaceFiles('alice', thread.id, async () => {
    entered();
    await pending;
    await writeFile(join(directory, 'late.txt'), 'saved');
  });
  await started;
  const archive = service.deleteThread('alice', thread.id);
  finish();
  await Promise.all([write, archive]);
  assert.equal(await readFile(join(directory, 'late.txt'), 'utf8'), 'saved');
  await service.deleteArchivedThread('alice', thread.id);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});
