import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectSummary } from '@aime/shared/projects';
import type { ThreadNavigationEvent } from '@aime/shared/threads';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { openSessionStub } from './fixtures/thread-session.js';

const project: ProjectSummary = {
  id: 'project123456789',
  name: 'Project',
  role: 'owner',
  pinned: false,
  archived: false,
  createdBy: 'alice',
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
};

function fixture(t: TestContext) {
  const { memory, threads } = fakeMemory();
  const service = new ThreadService(
    memory,
    {
      async validate() {},
      async createWorkspace() {
        return '/tmp/test';
      },
      open: openSessionStub,
    },
    {
      async list(userId) {
        return {
          projects: userId === 'alice' ? [project] : [],
          page: 0,
          hasMore: false,
        };
      },
      async assertMember(userId, projectId) {
        if (userId !== 'alice' || projectId !== project.id)
          throw new ThreadError('PROJECT_NOT_FOUND', 404);
        return { role: 'owner' };
      },
    },
  );
  t.after(() => service.shutdown());
  const seed = (
    id: string,
    resourceId: string,
    metadata?: Record<string, unknown>,
  ) => memory.createThread({ threadId: id, resourceId, title: id, metadata });
  return { service, threads, seed };
}

for (const projectId of [undefined, project.id]) {
  test(`${projectId ? 'project' : 'personal'} lists exclude goalJudge keys before pagination`, async (t) => {
    const { service, seed, threads } = fixture(t);
    const resourceId = projectId ? `project:${projectId}` : 'user:alice';
    const judgeValues = [true, false, null, 0, '', undefined];
    const visibleIds: string[] = [];
    for (let i = 0; i < 13; i++) {
      await seed(`judge-${i}`, resourceId, {
        goalId: 'goal-01',
        goalJudge: judgeValues[i % judgeValues.length],
        forkedSubagent: true,
        parentThreadId: 'parent-thread',
      });
      const id = `chat-${i}`;
      visibleIds.push(id);
      await seed(
        id,
        resourceId,
        i % 2 ? { goalId: 'goal-01', forkedSubagent: true } : undefined,
      );
    }
    await seed('trailing-judge', resourceId, { goalJudge: true });
    await seed('other-user', 'user:bob');

    for (const perPage of [5, 10, 13]) {
      const pages = await Promise.all(
        Array.from({ length: Math.ceil(13 / perPage) + 1 }, (_, page) =>
          service.listThreads('alice', page, projectId, perPage),
        ),
      );
      for (const [page, result] of pages.entries()) {
        assert.deepEqual(
          result.threads.map((thread) => thread.id),
          visibleIds.slice(page * perPage, (page + 1) * perPage),
        );
        assert.equal(result.page, page);
        assert.equal(result.hasMore, (page + 1) * perPage < 13);
      }
    }
    assert.equal(threads.size, 28, 'filtering does not delete stored threads');
    if (projectId)
      await assert.rejects(
        () => service.listThreads('bob', 0, projectId),
        ThreadError,
      );
  });
}

test('a list containing only goal judges is empty with no next page', async (t) => {
  const { service, seed } = fixture(t);
  for (let i = 0; i < 12; i++)
    await seed(`judge-${i}`, 'user:alice', { goalJudge: false });
  assert.deepEqual(await service.listThreads('alice'), {
    threads: [],
    page: 0,
    hasMore: false,
  });
});

test('navigation snapshots and live updates exclude goal judges in both scopes', async (t) => {
  const { service, seed } = fixture(t);
  for (const resourceId of ['user:alice', `project:${project.id}`]) {
    await seed(`${resourceId}-chat`, resourceId, { goalId: 'goal-01' });
    await seed(`${resourceId}-judge`, resourceId, { goalJudge: false });
  }
  const events: ThreadNavigationEvent[] = [];
  service.subscribeNavigation(
    'alice',
    (event) => events.push(event),
    () => {},
  );
  async function until(check: () => boolean) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await delay(5);
    }
    assert.fail('Expected navigation event was not received');
  }
  await until(() => events.length > 0);
  const snapshot = events[0];
  assert.equal(snapshot.type, 'snapshot');
  if (snapshot.type !== 'snapshot') assert.fail('Missing snapshot');
  assert.deepEqual(
    snapshot.threads.map((thread) => thread.id),
    ['user:alice-chat', `project:${project.id}-chat`],
  );
  for (const resourceId of ['user:alice', `project:${project.id}`]) {
    await service.updateThread('alice', `${resourceId}-judge`, {
      title: 'Judge updated',
    });
    await service.updateThread('alice', `${resourceId}-chat`, {
      title: 'Chat updated',
    });
  }
  service.refreshNavigation('alice');
  await until(
    () => events.filter((event) => event.type === 'snapshot').length === 2,
  );
  const updates = events.filter((event) => event.type === 'upsert');
  assert.deepEqual(
    updates.map((event) => event.thread.id),
    ['user:alice-chat', `project:${project.id}-chat`],
  );
  assert.ok(updates.every((event) => event.thread.title === 'Chat updated'));
  const refreshed = events.at(-1)!;
  assert.ok(refreshed.type === 'snapshot');
  assert.deepEqual(
    refreshed.threads.map((thread) => thread.id),
    snapshot.threads.map((thread) => thread.id),
  );
});
