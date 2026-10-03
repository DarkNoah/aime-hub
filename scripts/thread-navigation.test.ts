import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectSummary } from '@aime/shared/projects';
import type {
  ThreadNavigationEvent,
  ThreadSummary,
  ThreadList,
} from '@aime/shared/threads';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import { ThreadNavigationFeed } from '../apps/server/src/modules/threads/navigation-feed.js';
import { createThreadListResource } from '../apps/web/src/components/chat/thread-list-resource.js';
import { createThreadNavigationResource } from '../apps/web/src/components/chat/thread-navigation-resource.js';
import { createProjectNavigationResource } from '../apps/web/src/pages/projects/navigation-resource.js';
import { fakeMemory } from './fixtures/thread-memory.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const project: ProjectSummary = {
  id: 'project123456789',
  name: 'Project',
  role: 'owner',
  createdBy: 'alice',
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};
const thread = (
  id: string,
  status: ThreadSummary['status'] = 'idle',
): ThreadSummary => ({
  ...settings,
  id,
  title: id,
  projectId: project.id,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  status,
  queue: [],
  error: null,
});
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  throw new Error('Expected navigation update was not received');
}

test('global summaries follow background runs, queue, rename, deletion and membership without opening a chat', async (t) => {
  const { memory } = fakeMemory();
  const members = new Set(['alice', 'bob']);
  let context: Parameters<ChatRunner['execute']>[0] | undefined;
  let finish: (() => void) | undefined;
  const service = new ThreadService(
    memory,
    {
      async validate() {},
      async createWorkspace() {
        return '/tmp/test';
      },
      async execute(value) {
        context = value;
        value.onStatus('running');
        await new Promise<void>((resolve) => {
          finish = resolve;
          value.signal.addEventListener('abort', resolve as () => void, {
            once: true,
          });
        });
      },
    },
    {
      async list(userId) {
        return {
          projects: members.has(userId) ? [project] : [],
          hasMore: false,
          page: 0,
        };
      },
      async assertMember(userId) {
        if (!members.has(userId))
          throw new ThreadError('PROJECT_NOT_FOUND', 404);
        return { role: 'owner' };
      },
    },
  );
  t.after(() => service.shutdown());
  const personal = await service.createThread('alice', settings);
  const shared = await service.createThread('alice', {
    ...settings,
    projectId: project.id,
  });
  const alice: ThreadNavigationEvent[] = [],
    bob: ThreadNavigationEvent[] = [],
    outsider: ThreadNavigationEvent[] = [];
  const off = service.subscribeNavigation(
    'alice',
    (event) => alice.push(event),
    () => {},
  );
  service.subscribeNavigation(
    'bob',
    (event) => bob.push(event),
    () => {},
  );
  service.subscribeNavigation(
    'outsider',
    (event) => outsider.push(event),
    () => {},
  );
  await until(() => alice.length > 0 && bob.length > 0 && outsider.length > 0);
  assert.equal(alice[0].type, 'snapshot');
  assert.equal(bob[0].type, 'snapshot');
  if (bob[0].type === 'snapshot')
    assert.deepEqual(
      bob[0].threads.map((item) => item.id),
      [shared.id],
    );
  const latest = () =>
    alice
      .filter(
        (event) => event.type === 'upsert' && event.thread.id === shared.id,
      )
      .at(-1);
  await service.run('bob', shared.id, {
    ...settings,
    id: 'message01',
    parts: [{ type: 'text', text: 'Auto title' }],
    isImmediate: false,
  });
  await until(
    () =>
      !!context &&
      latest()?.type === 'upsert' &&
      (latest() as { thread: ThreadSummary }).thread.status === 'running',
  );
  await delay(60);
  const beforeTokens = alice.length;
  context!.onMessage({
    id: 'answer',
    role: 'assistant',
    parts: [{ type: 'text', text: 'token' }],
  });
  await delay(80);
  assert.equal(
    alice.length,
    beforeTokens,
    'token updates do not rebroadcast unchanged summaries',
  );
  await service.run('bob', shared.id, {
    ...settings,
    id: 'message02',
    parts: [{ type: 'text', text: 'Queued' }],
    isImmediate: false,
  });
  await until(
    () => (latest() as { thread: ThreadSummary }).thread.queue.length === 1,
  );
  await service.cancelQueued('bob', shared.id, 'message02');
  await service.abort('bob', shared.id);
  await until(
    () => (latest() as { thread: ThreadSummary }).thread.status === 'canceled',
  );
  assert.ok(
    alice.some(
      (event) =>
        event.type === 'upsert' &&
        event.thread.stopping &&
        event.thread.status === 'running',
    ),
  );
  await service.updateThread('alice', shared.id, {
    title: 'Renamed elsewhere',
  });
  await until(() =>
    bob.some(
      (event) =>
        event.type === 'upsert' && event.thread.title === 'Renamed elsewhere',
    ),
  );
  members.delete('bob');
  service.invalidateProject(project.id, 'bob');
  await until(() => bob.at(-1)?.type === 'snapshot');
  const revoked = bob.at(-1)!;
  assert.ok(
    revoked.type === 'snapshot' &&
      !revoked.projects.length &&
      !revoked.threads.length,
  );
  await service.deleteThread('alice', shared.id);
  await until(() =>
    alice.some((event) => event.type === 'remove' && event.id === shared.id),
  );
  assert.equal(
    outsider.length,
    1,
    'no private changes or project IDs leak to other users',
  );
  off();
  await service.updateThread('alice', personal.id, { title: 'Offline edit' });
  const reconnect: ThreadNavigationEvent[] = [];
  service.subscribeNavigation(
    'alice',
    (event) => reconnect.push(event),
    () => {},
  );
  await until(() => reconnect.length > 0);
  assert.ok(
    reconnect[0].type === 'snapshot' &&
      reconnect[0].threads.length === 1 &&
      reconnect[0].threads[0].title === 'Offline edit',
  );
  finish?.();
});

test('events arriving during initial snapshot are delivered after it, and disposal cancels pending sends', async () => {
  let release!: (value: ThreadNavigationEvent) => void;
  const feed = new ThreadNavigationFeed(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    async () => {},
  );
  const received: ThreadNavigationEvent[] = [];
  const off = feed.subscribe(
    'alice',
    (event) => received.push(event),
    () => {},
  );
  await delay(0);
  feed.publish('user:alice', { type: 'upsert', thread: thread('new') });
  release({ type: 'snapshot', threads: [], projects: [] });
  await until(() => received.length === 2);
  assert.deepEqual(
    received.map((event) => event.type),
    ['snapshot', 'upsert'],
  );
  feed.publish('user:alice', { type: 'remove', id: 'new', projectId: null });
  off();
  await delay(0);
  assert.equal(received.length, 2);
  feed.close();
});

test('global cache counts all project runs, preserves paging and reconciles offline changes without stale HTTP resurrection', async () => {
  let resolvePage!: (page: ThreadList) => void;
  const personal = createThreadListResource(
    () =>
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
  );
  const projects = createProjectNavigationResource();
  const global = createThreadNavigationResource(personal, projects);
  const oldPage = personal.loadMore();
  const items = Array.from({ length: 14 }, (_, i) => ({
    ...thread(
      `thread-${String(i).padStart(2, '0')}`,
      i < 3 ? 'running' : i === 3 ? 'pending' : 'idle',
    ),
    ...(i === 3 ? { stopping: true } : {}),
  }));
  global.receive({ type: 'snapshot', threads: items, projects: [project] });
  assert.equal(
    global.runningCount(project.id),
    4,
    'counts exist before the project is opened',
  );
  const list = projects.threads(project.id);
  assert.equal(list.getSnapshot().threads.length, 5);
  assert.equal(
    list.getSnapshot().threads.filter((item) => item.status === 'running')
      .length,
    0,
    'running rows need not be in the visible page',
  );
  await list.loadMore();
  const before = list.getSnapshot();
  global.receive({
    type: 'upsert',
    thread: { ...items[13], title: 'Live rename' },
  });
  list.update({ ...items[13], title: 'Stale message stream' });
  assert.equal(
    list.getSnapshot().threads.find((item) => item.id === items[13].id)?.title,
    'Live rename',
  );
  assert.equal(list.getSnapshot().page, before.page);
  assert.deepEqual(
    list.getSnapshot().threads.map((item) => item.id),
    before.threads.map((item) => item.id),
  );
  global.receive({ type: 'upsert', thread: { ...items[0], status: 'failed' } });
  assert.equal(global.runningCount(project.id), 3);
  global.receive({ type: 'remove', id: items[1].id, projectId: project.id });
  assert.equal(global.runningCount(project.id), 2);
  resolvePage({
    threads: [{ ...thread('deleted-offline'), projectId: null }],
    page: 0,
    hasMore: false,
  });
  await oldPage;
  assert.deepEqual(personal.getSnapshot().threads, []);
  const pageBeforeReconnect = list.getSnapshot().page;
  global.receive({
    type: 'snapshot',
    threads: [{ ...items[13], title: 'Offline rename' }],
    projects: [project],
  });
  assert.equal(global.runningCount(project.id), 0);
  assert.equal(list.getSnapshot().page, pageBeforeReconnect);
  assert.equal(list.getSnapshot().threads[0].title, 'Offline rename');
  assert.equal(list.getSnapshot().hasMore, false);
  global.receive({ type: 'project-removed', projectId: project.id });
  assert.deepEqual(list.getSnapshot().threads, []);
  assert.deepEqual(projects.projects.getSnapshot().projects, []);
  personal.cancel();
  projects.cancel();
});

test('navigation HTTP SSE requires authentication and broadcasts create/edit/delete to another connection', async (t) => {
  const { createServer } = await import('node:http');
  const { createApp } = await import('../apps/server/src/app.js');
  const { memory } = fakeMemory();
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return '/tmp/test';
    },
    async execute() {},
  });
  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const id = headers.get('x-test-user');
        return id ? { user: { id }, session: { id: 'test-session' } } : null;
      },
    },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, {
    threads: service,
    models: {} as never,
    webOrigin: 'http://localhost:5173',
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/threads`;
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await service.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  assert.equal((await fetch(`${base}/events`)).status, 401);
  const source = await fetch(`${base}/events`, {
    headers: { 'x-test-user': 'alice' },
    signal: controller.signal,
  });
  assert.equal(source.status, 200);
  assert.match(source.headers.get('content-type')!, /text\/event-stream/);
  const reader = source.body!.getReader();
  let buffer = '';
  const decoder = new TextDecoder();
  async function next(): Promise<ThreadNavigationEvent> {
    while (!buffer.includes('\n\n')) {
      const result = await reader.read();
      assert.equal(result.done, false);
      buffer += decoder.decode(result.value, { stream: true });
    }
    const end = buffer.indexOf('\n\n');
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return JSON.parse(
      frame
        .split('\n')
        .find((line) => line.startsWith('data: '))!
        .slice(6),
    );
  }
  assert.equal((await next()).type, 'snapshot');
  const request = async (path: string, method: string, body?: object) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'x-test-user': 'alice',
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const created = await request('', 'POST', settings);
  assert.equal(created.status, 201);
  const value = (await created.json()) as ThreadSummary;
  const added = await next();
  assert.ok(added.type === 'upsert' && added.thread.id === value.id);
  assert.equal(
    (
      await request(`/${value.id}`, 'PATCH', {
        title: 'Changed from another tab',
      })
    ).status,
    200,
  );
  const edited = await next();
  assert.ok(
    edited.type === 'upsert' &&
      edited.thread.title === 'Changed from another tab',
  );
  assert.equal((await request(`/${value.id}`, 'DELETE')).status, 204);
  assert.deepEqual(await next(), {
    type: 'remove',
    id: value.id,
    projectId: null,
  });
});
