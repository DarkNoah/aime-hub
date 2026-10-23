import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectSummary } from '@aime/shared/projects';
import type { ThreadList, ThreadSummary } from '@aime/shared/threads';
import {
  PLUGIN_API_VERSION,
  pluginManifestSchema,
} from '../packages/plugin-sdk/src/index.js';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import { createThreadListResource } from '../apps/web/src/components/chat/thread-list-resource.js';
import { createThreadNavigationResource } from '../apps/web/src/components/chat/thread-navigation-resource.js';
import { createProjectNavigationResource } from '../apps/web/src/pages/projects/navigation-resource.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { openSessionStub } from './fixtures/thread-session.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const thread = (id: string, plugin?: string): ThreadSummary => ({
  ...settings,
  id,
  plugin,
  title: id,
  projectId: null,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  status: 'idle',
  queueCount: 0,
  error: null,
});

test('plugin HTTP filtering precedes pagination and preserves user, project and archive boundaries', async (t) => {
  const { memory } = fakeMemory();
  const service = new ThreadService(
    memory,
    {
      async validate() {},
      async createWorkspace() {
        return '/tmp/plugin-thread-test';
      },
      open: openSessionStub,
    },
    {
      async assertMember(userId, projectId) {
        if (userId !== 'alice' || projectId !== 'project000000001')
          throw new ThreadError('PROJECT_NOT_FOUND', 404);
        return { role: 'owner' };
      },
    },
  );
  t.after(() => service.shutdown());
  const expected: string[] = [];
  const ordinary: string[] = [];
  const projectOrdinary: string[] = [];
  for (let i = 0; i < 12; i++) {
    ordinary.push((await service.createThread('alice', settings)).id);
    await service.createThread('alice', { ...settings, plugin: 'other' });
    projectOrdinary.push(
      (
        await service.createThread('alice', {
          ...settings,
          projectId: 'project000000001',
        })
      ).id,
    );
    await service.createThread('alice', {
      ...settings,
      projectId: 'project000000001',
      plugin: 'other',
    });
    expected.push(
      (
        await service.createThread('alice', {
          ...settings,
          plugin: 'vibe-quant',
          title: `Quant ${i}`,
        })
      ).id,
    );
  }
  await service.createThread('bob', { ...settings, plugin: 'vibe-quant' });
  const shared = await service.createThread('alice', {
    ...settings,
    plugin: 'vibe-quant',
    projectId: 'project000000001',
  });
  const archived = await service.createThread('alice', {
    ...settings,
    plugin: 'vibe-quant',
  });
  await service.deleteThread('alice', archived.id);
  const { createApp } = await import('../apps/server/src/app.js');
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return id ? { user: { id }, session: { id: 'test' } } : null;
      },
    },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, {
    threads: service,
    models: {} as never,
    webOrigin: 'http://localhost:5173',
  });
  const query = '/api/threads?plugin=vibe-quant&perPage=5';
  assert.equal((await app.request(query)).status, 401);
  const pages: ThreadList[] = [];
  for (let page = 0; page < 3; page++) {
    const response = await app.request(`${query}&page=${page}`, {
      headers: { 'x-test-user': 'alice' },
    });
    assert.equal(response.status, 200);
    pages.push((await response.json()) as ThreadList);
  }
  assert.deepEqual(
    pages.map((page) => page.threads.length),
    [5, 5, 2],
  );
  assert.deepEqual(
    pages.map((page) => page.hasMore),
    [true, true, false],
  );
  assert.deepEqual(
    pages.flatMap((page) => page.threads.map((item) => item.id)),
    expected,
  );
  assert.ok(
    pages.every((page) =>
      page.threads.every((item) => item.plugin === 'vibe-quant'),
    ),
  );
  for (const [scope, ids] of [
    ['', ordinary],
    ['&projectId=project000000001', projectOrdinary],
  ] as const) {
    const defaults: ThreadList[] = [];
    for (let page = 0; page < 3; page++) {
      const response = await app.request(
        `/api/threads?perPage=5&page=${page}${scope}`,
        { headers: { 'x-test-user': 'alice' } },
      );
      assert.equal(response.status, 200);
      defaults.push((await response.json()) as ThreadList);
    }
    assert.deepEqual(
      defaults.map((page) => page.threads.length),
      [5, 5, 2],
    );
    assert.deepEqual(
      defaults.map((page) => page.hasMore),
      [true, true, false],
    );
    assert.deepEqual(
      defaults.flatMap((page) => page.threads.map((item) => item.id)),
      ids,
    );
    assert.ok(
      defaults.every((page) =>
        page.threads.every((item) => item.plugin === undefined),
      ),
    );
  }
  assert.equal(
    (await service.listThreads('alice', 0, undefined, 5, 'missing')).hasMore,
    false,
  );
  assert.deepEqual(
    (
      await service.listThreads('alice', 0, shared.projectId!, 5, 'vibe-quant')
    ).threads.map((item) => item.id),
    [shared.id],
  );
  await assert.rejects(
    service.listThreads('bob', 0, shared.projectId!, 5, 'vibe-quant'),
    { code: 'PROJECT_NOT_FOUND' },
  );
  await assert.rejects(service.listThreads('bob', 0, shared.projectId!), {
    code: 'PROJECT_NOT_FOUND',
  });
});

test('plugin navigation has independent pages and follows live status, rename, archive, restore and reconnect', async () => {
  const personal = createThreadListResource(undefined, 5);
  const navigation = createThreadNavigationResource(
    personal,
    createProjectNavigationResource(),
  );
  const quant = navigation.pluginThreads('vibe-quant');
  const items = Array.from({ length: 12 }, (_, i) =>
    thread(`quant-${String(i).padStart(2, '0')}`, 'vibe-quant'),
  );
  const snapshot = [
    ...items,
    thread('ordinary'),
    thread('other', 'other'),
    { ...thread('project', 'vibe-quant'), projectId: 'project000000001' },
  ];
  navigation.receive({ type: 'snapshot', threads: snapshot, projects: [] });
  assert.equal(quant.getSnapshot().threads.length, 5);
  assert.equal(quant.getCatalogSnapshot().threads.length, 12);
  assert.equal(navigation.pluginThreads('vibe-quant'), quant);
  assert.deepEqual(
    navigation
      .pluginThreads('other')
      .getSnapshot()
      .threads.map((item) => item.id),
    ['other'],
  );
  await quant.loadMore();
  assert.equal(quant.getSnapshot().threads.length, 10);
  assert.deepEqual(personal.getSnapshot().threads, [thread('ordinary')]);
  const order = quant.getSnapshot().threads.map((item) => item.id);
  const updated = {
    ...quant.getSnapshot().threads[4],
    title: 'Renamed',
    status: 'running' as const,
  };
  navigation.receive({ type: 'upsert', thread: updated });
  assert.deepEqual(
    quant.getSnapshot().threads.map((item) => item.id),
    order,
  );
  assert.equal(quant.getSnapshot().page, 1);
  assert.equal(quant.getSnapshot().threads[4].status, 'running');
  quant.update({ ...updated, status: 'idle' });
  assert.equal(quant.getSnapshot().threads[4].status, 'running');
  navigation.receive({ type: 'upsert', thread: thread('unrelated', 'other') });
  assert.equal(quant.getSnapshot().threads.length, 10);
  navigation.receive({ type: 'remove', id: updated.id, projectId: null });
  assert.ok(
    !quant.getCatalogSnapshot().threads.some((item) => item.id === updated.id),
  );
  navigation.receive({ type: 'upsert', thread: updated });
  assert.equal(quant.getSnapshot().threads[0].id, updated.id);
  navigation.receive({ type: 'snapshot', threads: [updated], projects: [] });
  assert.deepEqual(quant.getSnapshot().threads, [updated]);
  assert.equal(quant.getSnapshot().page, 1);
  assert.equal(quant.getSnapshot().hasMore, false);
  navigation.receive({ type: 'snapshot', threads: [], projects: [] });
  assert.deepEqual(quant.getCatalogSnapshot().threads, []);
  navigation.cancel();
});

test('default personal and project navigation excludes plugin chats from pages, picker catalogs and running counts', async () => {
  const project: ProjectSummary = {
    id: 'project000000001',
    name: 'Project',
    role: 'owner',
    pinned: false,
    archived: false,
    createdBy: 'alice',
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
  const personal = createThreadListResource(undefined, 5);
  const projects = createProjectNavigationResource();
  const shared = projects.threads(project.id);
  const navigation = createThreadNavigationResource(personal, projects);
  const ordinary = Array.from({ length: 7 }, (_, i) => thread(`ordinary-${i}`));
  const sharedOrdinary = ordinary.map((item) => ({
    ...item,
    id: `shared-${item.id}`,
    projectId: project.id,
    status: 'running' as const,
  }));
  const pluginThread = thread('plugin', 'vibe-quant');
  const sharedPlugin = {
    ...thread('shared-plugin', 'vibe-quant'),
    projectId: project.id,
    status: 'running' as const,
  };
  const snapshot = [...ordinary, ...sharedOrdinary, pluginThread, sharedPlugin];
  navigation.receive({
    type: 'snapshot',
    threads: snapshot,
    projects: [project],
  });
  for (const resource of [personal, shared]) {
    assert.equal(resource.getSnapshot().threads.length, 5);
    assert.equal(resource.getSnapshot().hasMore, true);
    assert.equal(resource.getCatalogSnapshot().threads.length, 7);
    assert.ok(
      resource
        .getCatalogSnapshot()
        .threads.every((item) => item.plugin === undefined),
    );
    await resource.loadMore();
    assert.equal(resource.getSnapshot().threads.length, 7);
    assert.equal(resource.getSnapshot().hasMore, false);
  }
  assert.equal(navigation.runningCount(project.id), 7);
  assert.deepEqual(
    navigation.pluginThreads('vibe-quant').getSnapshot().threads,
    [pluginThread],
  );
  navigation.receive({
    type: 'upsert',
    thread: { ...sharedPlugin, title: 'Renamed' },
  });
  navigation.receive({
    type: 'upsert',
    thread: { ...pluginThread, status: 'running' },
  });
  assert.equal(personal.getSnapshot().threads.length, 7);
  assert.equal(shared.getSnapshot().threads.length, 7);
  assert.equal(navigation.runningCount(project.id), 7);

  for (const item of [ordinary[0], sharedOrdinary[0]])
    navigation.receive({
      type: 'upsert',
      thread: { ...item, plugin: 'other' },
    });
  for (const resource of [personal, shared]) {
    assert.equal(resource.getSnapshot().page, 1);
    assert.equal(resource.getSnapshot().threads.length, 6);
    assert.equal(resource.getCatalogSnapshot().threads.length, 6);
  }
  assert.equal(navigation.runningCount(project.id), 6);
  for (const item of [ordinary[0], sharedOrdinary[0]])
    navigation.receive({ type: 'upsert', thread: item });
  navigation.receive({
    type: 'snapshot',
    threads: snapshot,
    projects: [project],
  });
  for (const resource of [personal, shared]) {
    assert.equal(resource.getSnapshot().page, 1);
    assert.equal(resource.getSnapshot().threads.length, 7);
    assert.ok(
      resource
        .getCatalogSnapshot()
        .threads.every((item) => item.plugin === undefined),
    );
  }
  assert.equal(navigation.runningCount(project.id), 7);

  // Project lists opened after synchronization apply the same default scope.
  const lazyProjects = createProjectNavigationResource();
  lazyProjects.synchronize([project], [...sharedOrdinary, sharedPlugin]);
  assert.equal(
    lazyProjects.threads(project.id).getCatalogSnapshot().threads.length,
    7,
  );
  navigation.cancel();
});

test('filtered resources discard late HTTP pages after live synchronization and handle changed plugin tags', async () => {
  let resolve!: (page: ThreadList) => void;
  const resource = createThreadListResource(
    () =>
      new Promise<ThreadList>((done) => {
        resolve = done;
      }),
    5,
    'vibe-quant',
  );
  const pending = resource.loadMore();
  const current = thread('current', 'vibe-quant');
  resource.synchronize([current, thread('other', 'other')]);
  resolve({ threads: [thread('stale', 'vibe-quant')], page: 0, hasMore: true });
  await pending;
  assert.deepEqual(resource.getSnapshot().threads, [current]);
  resource.update({ ...current, plugin: 'other' }, true);
  assert.deepEqual(resource.getSnapshot().threads, []);
  resource.cancel();
});

test('plugin chat navigation is opt-in and retains an optional default agent', () => {
  const base = {
    id: 'sample',
    name: 'Sample',
    description: '',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
  };
  assert.equal(pluginManifestSchema.parse(base).chatThreads, undefined);
  assert.deepEqual(
    pluginManifestSchema.parse({ ...base, chatThreads: {} }).chatThreads,
    {},
  );
  assert.deepEqual(
    pluginManifestSchema.parse({
      ...base,
      chatThreads: { agentId: 'plugin:sample:agent' },
    }).chatThreads,
    { agentId: 'plugin:sample:agent' },
  );
});
