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
  queue: [],
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
