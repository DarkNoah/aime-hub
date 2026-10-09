import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectList, ProjectSummary } from '@aime/shared/projects';
import type { ThreadSummary } from '@aime/shared/threads';
import {
  createProjectNavigationResource,
  createProjectListResource,
} from '../apps/web/src/pages/projects/navigation-resource.js';

const project = (id: string): ProjectSummary => ({
  id,
  name: id,
  createdBy: 'alice',
  role: 'owner',
  pinned: false,
  archived: false,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
});
const thread = (id: string, projectId: string): ThreadSummary => ({
  ...project(id),
  title: id,
  projectId,
  model: null,
  reasoningEffort: 'auto',
  status: 'idle',
  queueCount: 0,
  error: null,
});

test('project navigation uses five-item pages and lazy, shared, isolated thread caches', async () => {
  const requestedProjects: number[] = [];
  const requestedThreads: string[] = [];
  const items = Array.from({ length: 12 }, (_, i) => project(`project-${i}`));
  const resource = createProjectNavigationResource(
    async (page = 0, _signal, perPage = 20) => {
      assert.equal(perPage, 5);
      requestedProjects.push(page);
      return {
        projects: items.slice(page * perPage, (page + 1) * perPage),
        page,
        hasMore: (page + 1) * perPage < items.length,
      };
    },
    async (page = 0, _signal, projectId, perPage = 10) => {
      assert.equal(perPage, 5);
      requestedThreads.push(`${projectId}:${page}`);
      return {
        threads: Array.from({ length: page < 2 ? 5 : 2 }, (_, i) =>
          thread(`${projectId}-${page * perPage + i}`, projectId!),
        ),
        page,
        hasMore: page < 2,
      };
    },
  );
  const first = resource.projects.loadMore();
  assert.equal(resource.projects.loadMore(), first);
  await first;
  assert.equal(resource.projects.getSnapshot().projects.length, 5);
  const a = resource.threads('a');
  assert.equal(resource.threads('a'), a);
  assert.deepEqual(requestedThreads, []);
  const loadingThreads = a.loadMore();
  assert.equal(a.loadMore(), loadingThreads);
  await loadingThreads;
  assert.equal(a.getSnapshot().threads.length, 5);
  await a.loadMore();
  await a.loadMore();
  await a.loadMore();
  assert.equal(a.getSnapshot().threads.length, 12);
  assert.equal(a.getSnapshot().hasMore, false);
  assert.equal(resource.threads('b').getSnapshot().page, -1);
  await resource.projects.loadMore();
  await resource.projects.loadMore();
  await resource.projects.loadMore();
  assert.deepEqual(requestedProjects, [0, 1, 2]);
  assert.deepEqual(requestedThreads, ['a:0', 'a:1', 'a:2']);
  assert.equal(resource.projects.getSnapshot().projects.length, 12);
  resource.cancel();
});

test('project paging preserves edits and removals made during a pending response', async () => {
  let resolve!: (page: ProjectList) => void;
  const resource = createProjectListResource(
    async () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const loading = resource.loadMore();
  resource.update({ ...project('a'), name: 'Renamed' });
  resource.remove('b');
  resolve({
    projects: [project('a'), project('b'), project('c')],
    page: 0,
    hasMore: true,
  });
  await loading;
  const second = resource.loadMore();
  resolve({ projects: [project('c'), project('d')], page: 1, hasMore: false });
  await second;
  assert.deepEqual(
    resource.getSnapshot().projects.map((item) => item.name),
    ['Renamed', 'c', 'd'],
  );
  assert.equal(resource.getSnapshot().page, 1);
});

test('project paging retries the failed page and ignores cancelled responses', async () => {
  let resolve!: (page: ProjectList) => void;
  const requested: number[] = [];
  const resource = createProjectListResource(async (page = 0) => {
    requested.push(page);
    if (requested.length === 1)
      return new Promise((done) => {
        resolve = done;
      });
    if (requested.length === 2) throw new TypeError('Offline');
    return { projects: [project('current')], page, hasMore: false };
  });
  const cancelled = resource.loadMore();
  resource.cancel();
  await resource.loadMore();
  resolve({ projects: [project('stale')], page: 9, hasMore: false });
  await cancelled;
  assert.equal(resource.getSnapshot().page, -1);
  assert.equal(resource.getSnapshot().error, 'errors.network');
  await resource.loadMore();
  assert.deepEqual(requested, [0, 0, 0]);
  assert.deepEqual(
    resource.getSnapshot().projects.map((item) => item.id),
    ['current'],
  );
});

test('pinning reorders loaded projects and unpinning restores their position without resetting pagination', async () => {
  const navigation = createProjectNavigationResource();
  const items = Array.from({ length: 12 }, (_, index) =>
    project(String(index).padStart(2, '0')),
  );
  navigation.synchronize(items, []);
  await navigation.projects.loadMore();
  const before = navigation.projects.getSnapshot();
  const target = before.projects[7];
  navigation.updateProject({ ...target, pinned: true });
  assert.equal(navigation.projects.getSnapshot().projects[0].id, target.id);
  assert.equal(navigation.projects.getSnapshot().projects.length, 10);
  assert.equal(navigation.projects.getSnapshot().page, before.page);
  navigation.updateProject(target);
  assert.deepEqual(navigation.projects.getSnapshot().projects, before.projects);
  navigation.cancel();
});

test('archive and restore move projects between lists while retaining project chat caches', async () => {
  const navigation = createProjectNavigationResource();
  const active = { ...project('a'), pinned: true };
  const archived = { ...active, archived: true };
  const conversation = thread('chat', active.id);
  navigation.synchronize([active], [conversation]);
  const chats = navigation.threads(active.id);
  navigation.updateProject(archived);
  assert.deepEqual(navigation.projects.getSnapshot().projects, []);
  assert.deepEqual(navigation.archivedProjects.getSnapshot().projects, [
    archived,
  ]);
  assert.equal(navigation.projects.getSnapshot().hasMore, false);
  navigation.synchronize([archived], [conversation]);
  assert.equal(navigation.threads(active.id), chats);
  assert.deepEqual(chats.getSnapshot().threads, [conversation]);
  navigation.updateProject(active);
  assert.deepEqual(navigation.projects.getSnapshot().projects, [active]);
  assert.deepEqual(navigation.archivedProjects.getSnapshot().projects, []);
  navigation.removeProject(active.id);
  assert.deepEqual(navigation.projects.getSnapshot().projects, []);
  assert.deepEqual(navigation.archivedProjects.getSnapshot().projects, []);
  navigation.cancel();
});

test('a stale in-flight list cannot restore an archived project or overwrite a pin', async () => {
  let resolve!: (page: ProjectList) => void;
  const navigation = createProjectNavigationResource(
    async () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const loading = navigation.projects.loadMore();
  navigation.updateProject({ ...project('a'), archived: true });
  navigation.updateProject({ ...project('b'), pinned: true });
  resolve({
    projects: [project('a'), project('b'), project('c')],
    page: 0,
    hasMore: false,
  });
  await loading;
  assert.deepEqual(
    navigation.projects
      .getSnapshot()
      .projects.map(({ id, pinned }) => ({ id, pinned })),
    [
      { id: 'b', pinned: true },
      { id: 'c', pinned: false },
    ],
  );
  assert.equal(navigation.archivedProjects.getSnapshot().projects[0].id, 'a');
  navigation.cancel();
});

test('archived pagination requests its own filter and does not leak into the active list', async () => {
  const navigation = createProjectNavigationResource(
    async (page = 0, _signal, perPage, status) => {
      assert.equal(status, 'archived');
      assert.equal(perPage, 5);
      return {
        projects: [{ ...project('archived'), archived: true }],
        page,
        hasMore: false,
      };
    },
  );
  await navigation.archivedProjects.loadMore();
  assert.equal(navigation.archivedProjects.getSnapshot().projects.length, 1);
  assert.equal(navigation.projects.getSnapshot().page, -1);
  navigation.cancel();
});
