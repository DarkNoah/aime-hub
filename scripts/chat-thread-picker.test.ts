import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadSummary } from '@aime/shared/threads';
import type { ProjectSummary } from '@aime/shared/projects';
import { createThreadListResource } from '../apps/web/src/components/chat/thread-list-resource.js';
import { createProjectListResource } from '../apps/web/src/pages/projects/navigation-resource.js';

const threads: ThreadSummary[] = Array.from({ length: 25 }, (_, i) => ({
  id: `thread-${i}`,
  title: i === 24 ? 'Historical design discussion' : `Chat ${i}`,
  model: null,
  reasoningEffort: 'auto',
  status: 'idle',
  queueCount: 0,
  error: null,
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: new Date(Date.UTC(2026, 9, 7, 0, 0, 25 - i)).toISOString(),
}));

test('thread picker catalog includes unpaged titles without expanding the sidebar', () => {
  const resource = createThreadListResource(undefined, 5);
  resource.synchronize(threads);
  assert.equal(resource.getSnapshot().threads.length, 5);
  const catalog = resource.getCatalogSnapshot();
  assert.equal(catalog.threads.length, 25);
  assert.equal(catalog.hasMore, false);
  assert.equal(
    catalog.threads.filter((thread) =>
      thread.title?.toLowerCase().includes('historical'),
    )[0]?.id,
    'thread-24',
  );
  assert.equal(resource.getSnapshot().page, 0);
  assert.equal(resource.getCatalogSnapshot(), catalog);
});

test('catalog tracks unseen thread renames, deletions and access revocation', () => {
  const resource = createThreadListResource(undefined, 5);
  resource.synchronize(threads);
  resource.update({ ...threads[24], title: 'Renamed result' }, true);
  assert.equal(
    resource
      .getCatalogSnapshot()
      .threads.find((thread) => thread.id === 'thread-24')?.title,
    'Renamed result',
  );
  resource.remove('thread-24');
  assert.equal(
    resource
      .getCatalogSnapshot()
      .threads.some((thread) => thread.id === 'thread-24'),
    false,
  );
  resource.synchronize([]);
  assert.deepEqual(resource.getCatalogSnapshot().threads, []);
  assert.equal(resource.getCatalogSnapshot().hasMore, false);
});

test('HTTP catalog fallback retains earlier pages on failure and retries the failed page', async () => {
  const pages: number[] = [];
  let fail = true;
  const resource = createThreadListResource(async (page = 0) => {
    pages.push(page);
    if (page === 1 && fail) {
      fail = false;
      throw new TypeError('Offline');
    }
    return {
      threads: threads.slice(page * 5, (page + 1) * 5),
      page,
      hasMore: page < 4,
    };
  }, 5);
  await resource.loadMore();
  await resource.loadMore();
  assert.equal(resource.getCatalogSnapshot().threads.length, 5);
  assert.equal(resource.getCatalogSnapshot().error, 'errors.network');
  await resource.loadMore();
  assert.deepEqual(pages, [0, 1, 1]);
  while (resource.getCatalogSnapshot().hasMore) await resource.loadMore();
  assert.equal(resource.getCatalogSnapshot().threads.length, 25);
  assert.equal(resource.getCatalogSnapshot().error, null);
});

test('project breadcrumbs resolve unpaged projects and follow rename/removal', () => {
  const projects: ProjectSummary[] = Array.from({ length: 12 }, (_, i) => ({
    id: `project-${i}`,
    name: `Project ${i}`,
    role: 'owner',
    pinned: false,
    archived: false,
    createdBy: 'alice',
    createdAt: threads[i].createdAt,
    updatedAt: threads[i].updatedAt,
  }));
  const resource = createProjectListResource();
  resource.synchronize(projects);
  assert.equal(resource.getSnapshot().projects.length, 5);
  assert.equal(resource.getProject('project-11')?.name, 'Project 11');
  resource.update({ ...projects[11], name: 'Renamed project' });
  assert.equal(resource.getProject('project-11')?.name, 'Renamed project');
  resource.remove('project-11');
  assert.equal(resource.getProject('project-11'), undefined);
});

test('direct project loads can populate a breadcrumb before the navigation feed arrives', () => {
  const resource = createProjectListResource();
  resource.update({
    id: 'direct',
    name: 'Direct project',
    role: 'owner',
    pinned: false,
    archived: false,
    createdBy: 'alice',
    createdAt: threads[0].createdAt,
    updatedAt: threads[0].updatedAt,
  });
  assert.equal(resource.getProject('direct')?.name, 'Direct project');
});
