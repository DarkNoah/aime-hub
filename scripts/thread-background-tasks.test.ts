import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import {
  ThreadBackgroundTasks,
  type ThreadBackgroundTaskManager,
} from '../apps/server/src/modules/threads/background-tasks.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import type {
  ThreadBackgroundTask,
  ThreadSnapshot,
} from '@aime/shared/threads';
import type { UIMessage } from 'ai';

type Task = NonNullable<
  Awaited<ReturnType<ThreadBackgroundTaskManager['getTask']>>
>;
const settings = { model: null, reasoningEffort: 'auto' } as const;
const runner: ChatRunner = {
  async validate() {},
  async createWorkspace() {
    return 'workspace';
  },
  async execute() {},
};
const task = (
  id: string,
  threadId: string,
  status: Task['status'] = 'running',
  resourceId = 'user:alice',
): Task => ({
  id,
  threadId,
  resourceId,
  status,
  toolName: 'sleep',
  toolCallId: `call-${id}`,
  runId: 'run',
  agentId: 'chat',
  args: { durationMs: 3000 },
  createdAt: new Date(),
  retryCount: 0,
  maxRetries: 0,
  timeoutMs: 5000,
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('Background task update not received');
}
function fakeManager() {
  const tasks = new Map<string, Task>();
  const subscriptions = new Set<{
    options: NonNullable<Parameters<ThreadBackgroundTaskManager['stream']>[0]>;
    controller: ReadableStreamDefaultController<Record<string, unknown>>;
  }>();
  let opened = 0;
  const manager: ThreadBackgroundTaskManager = {
    async cancel(id) {
      const task = tasks.get(id);
      if (!task) throw new Error('Task not found');
      if (['pending', 'running', 'suspended'].includes(task.status))
        tasks.set(id, {
          ...task,
          status: 'cancelled',
          completedAt: new Date(),
        });
    },
    stream(options = {}) {
      opened++;
      return new ReadableStream({
        start(controller) {
          const subscription = { options, controller };
          subscriptions.add(subscription);
          options.abortSignal?.addEventListener(
            'abort',
            () => {
              subscriptions.delete(subscription);
              try {
                controller.close();
              } catch {
                /* Already errored. */
              }
            },
            { once: true },
          );
        },
      });
    },
    async getTask(id) {
      return structuredClone(tasks.get(id) ?? null);
    },
    async listTasks(filter = {}) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : filter.status
          ? [filter.status]
          : undefined;
      const all = [...tasks.values()]
        .filter(
          (t) =>
            (!filter.threadId || t.threadId === filter.threadId) &&
            (!filter.resourceId || t.resourceId === filter.resourceId) &&
            (!statuses || statuses.includes(t.status)),
        )
        .sort((a, b) => +b.createdAt - +a.createdAt);
      const size = filter.perPage ?? 100;
      const page = filter.page ?? 0;
      return {
        tasks: structuredClone(all.slice(page * size, (page + 1) * size)),
        total: all.length,
      };
    },
  };
  return {
    manager,
    tasks,
    subscriptions,
    get opened() {
      return opened;
    },
    emit(value: Task, type: string, output?: unknown) {
      tasks.set(value.id, value);
      for (const { options, controller } of subscriptions) {
        if (
          options.threadId !== value.threadId ||
          options.resourceId !== value.resourceId
        )
          continue;
        controller.enqueue({
          type,
          payload: { taskId: value.id, payload: output },
        });
      }
    },
  };
}

test('thread snapshots hydrate tasks and follow all manager lifecycle events with exact statuses', async (t) => {
  const { memory } = fakeMemory();
  const bg = fakeManager();
  const service = new ThreadService(memory, runner, undefined, bg.manager);
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  bg.tasks.set('pending', task('pending', thread.id, 'pending'));
  bg.tasks.set('other-thread', task('other-thread', 'elsewhere'));
  bg.tasks.set(
    'other-resource',
    task('other-resource', thread.id, 'running', 'user:bob'),
  );
  const snapshots: ThreadSnapshot<UIMessage>[] = [];
  await service.subscribe('alice', thread.id, (s) => snapshots.push(s));
  await service.subscribe('alice', thread.id, () => {});
  assert.equal(bg.opened, 1);
  assert.deepEqual(
    snapshots[0].backgroundTasks?.map((t) => t.id),
    ['pending'],
  );
  await assert.rejects(service.getThread('bob', thread.id));

  for (const [type, status] of [
    ['running', 'running'],
    ['suspended', 'suspended'],
    ['resumed', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['failed', 'timed_out'],
    ['cancelled', 'cancelled'],
  ] as const) {
    bg.emit(
      { ...task('pending', thread.id, status), result: false },
      `background-task-${type}`,
    );
    await until(
      () => snapshots.at(-1)?.backgroundTasks?.[0]?.status === status,
    );
    assert.equal(snapshots.at(-1)?.thread.status, 'idle');
  }
  bg.emit(task('output', thread.id), 'background-task-output', 0);
  await until(
    () =>
      snapshots
        .at(-1)
        ?.backgroundTasks?.some(
          (t) => t.id === 'output' && t.lastOutput === 0,
        ) === true,
  );
  bg.emit(task('output', thread.id), 'background-task-output', 'next');
  await until(
    () =>
      snapshots
        .at(-1)
        ?.backgroundTasks?.some(
          (t) => t.id === 'output' && t.lastOutput === 'next',
        ) === true,
  );
  assert.equal(snapshots.at(-1)?.backgroundTasks?.length, 2);
});

test('turn abort and browser disconnect retain the observer; reopening restores tasks from Mastra storage', async (t) => {
  const { memory } = fakeMemory();
  const bg = fakeManager();
  let started = false;
  const service = new ThreadService(
    memory,
    {
      ...runner,
      async execute({ signal, thread, onBackgroundTaskStarted }) {
        bg.tasks.set('queued', task('queued', thread.id, 'pending'));
        await onBackgroundTaskStarted?.('queued');
        started = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return { status: 'canceled', toolInteractions: [] };
      },
    },
    undefined,
    bg.manager,
  );
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  const disconnect = await service.subscribe('alice', thread.id, () => {});
  await service.run('alice', thread.id, {
    ...settings,
    id: 'message01',
    parts: [{ type: 'text', text: 'sleep' }],
    isImmediate: false,
  });
  await until(() => started);
  assert.equal(
    (await service.getThread('alice', thread.id)).backgroundTasks?.[0]?.status,
    'pending',
  );
  await service.abort('alice', thread.id);
  disconnect();
  assert.equal(bg.subscriptions.size, 1);
  bg.emit(task('queued', thread.id, 'completed'), 'background-task-completed');
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).backgroundTasks?.[0]
        ?.status === 'completed',
  );
  await service.shutdown();
  assert.equal(bg.subscriptions.size, 0);
  const reopened = new ThreadService(memory, runner, undefined, bg.manager);
  t.after(() => reopened.shutdown());
  assert.equal(
    (await reopened.getThread('alice', thread.id)).backgroundTasks?.[0]?.status,
    'completed',
  );
});

test('history is bounded while old pending and suspended tasks are retained', async (t) => {
  const bg = fakeManager();
  for (let i = 0; i < 110; i++)
    bg.tasks.set(`done-${i}`, {
      ...task(`done-${i}`, 'thread', 'completed'),
      createdAt: new Date(1000 + i),
    });
  for (const status of ['pending', 'suspended'] as const)
    bg.tasks.set(status, {
      ...task(status, 'thread', status),
      createdAt: new Date(1),
    });
  let tasks: ThreadBackgroundTask[] = [];
  const observer = new ThreadBackgroundTasks(
    bg.manager,
    { threadId: 'thread', resourceId: 'user:alice' },
    (value) => {
      tasks = value;
    },
    (error) => {
      throw error;
    },
  );
  t.after(() => observer.stop());
  await observer.ready;
  assert.equal(tasks.length, 102);
  assert.ok(tasks.some((t) => t.id === 'pending'));
  assert.ok(tasks.some((t) => t.id === 'suspended'));
  for (const task of tasks) assert.equal(typeof task.createdAt, 'string');
});

test('a failed stream reconnects and reconciles events missed while disconnected', async (t) => {
  const bg = fakeManager();
  let tasks: ThreadBackgroundTask[] = [];
  let errors = 0;
  const observer = new ThreadBackgroundTasks(
    bg.manager,
    { threadId: 'thread', resourceId: 'user:alice' },
    (value) => {
      tasks = value;
    },
    () => {
      errors++;
    },
  );
  t.after(() => observer.stop());
  await observer.ready;
  [...bg.subscriptions][0].controller.error(new Error('connection lost'));
  await until(() => errors === 1);
  bg.tasks.set('missed', task('missed', 'thread', 'completed'));
  await until(() => tasks.some((t) => t.id === 'missed'));
  assert.equal(bg.subscriptions.size, 1);
  assert.equal(bg.opened, 2);
});

test('failed initialization releases the subscription and can be retried', async (t) => {
  const { memory } = fakeMemory();
  const bg = fakeManager();
  const listTasks = bg.manager.listTasks;
  bg.manager.listTasks = async () => {
    throw new Error('Task storage unavailable');
  };
  t.mock.method(console, 'error', () => {});
  const service = new ThreadService(memory, runner, undefined, bg.manager);
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await assert.rejects(
    service.getThread('alice', thread.id),
    /Task storage unavailable/,
  );
  assert.equal(bg.subscriptions.size, 0);
  bg.manager.listTasks = listTasks;
  assert.deepEqual(
    (await service.getThread('alice', thread.id)).backgroundTasks,
    [],
  );
  assert.equal(bg.subscriptions.size, 1);
});

test('runtime expiry closes observers but running tasks keep their runtime alive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { memory } = fakeMemory();
  const bg = fakeManager();
  const service = new ThreadService(memory, runner, undefined, bg.manager);
  t.after(() => service.shutdown());
  const idle = await service.createThread('alice', settings);
  await service.getThread('alice', idle.id);
  const active = await service.createThread('alice', settings);
  bg.tasks.set('active', task('active', active.id));
  await service.getThread('alice', active.id);
  t.mock.timers.tick(15 * 60_000);
  assert.equal(bg.subscriptions.size, 1);
  assert.equal([...bg.subscriptions][0].options.threadId, active.id);
});

test('deletion checks background tasks and closes both personal and project observers', async (t) => {
  const { memory } = fakeMemory();
  const bg = fakeManager();
  const service = new ThreadService(
    memory,
    runner,
    {
      async assertMember() {
        return { role: 'owner' };
      },
    },
    bg.manager,
  );
  t.after(() => service.shutdown());
  const personal = await service.createThread('alice', settings);
  bg.tasks.set('busy', task('busy', personal.id, 'suspended'));
  await assert.rejects(service.deleteThread('alice', personal.id), {
    code: 'THREAD_BUSY',
  });
  bg.emit(task('busy', personal.id, 'cancelled'), 'background-task-cancelled');
  await until(
    async () =>
      (await service.getThread('alice', personal.id)).backgroundTasks?.[0]
        ?.status === 'cancelled',
  );
  await service.deleteThread('alice', personal.id);
  assert.equal(bg.subscriptions.size, 0);
  const project = await service.createThread('alice', {
    ...settings,
    projectId: 'project123456789',
  });
  await service.getThread('alice', project.id);
  bg.tasks.set(
    'project-task',
    task('project-task', project.id, 'running', 'project:project123456789'),
  );
  await assert.rejects(
    service.withProjectDeletion('project123456789', async () => {}),
    { code: 'PROJECT_BUSY' },
  );
  bg.tasks.set(
    'project-task',
    task('project-task', project.id, 'completed', 'project:project123456789'),
  );
  await service.withProjectDeletion('project123456789', async () => {});
  assert.equal(bg.subscriptions.size, 0);
});

test('manual cancellation verifies task scope and refreshes the task without stopping the foreground turn', async (t) => {
  const { memory } = fakeMemory();
  const bg = fakeManager();
  let started = false;
  let foregroundSignal: AbortSignal | undefined;
  const service = new ThreadService(
    memory,
    {
      ...runner,
      async execute({ signal, onStatus }) {
        foregroundSignal = signal;
        onStatus('running');
        started = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    },
    undefined,
    bg.manager,
  );
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  for (const status of [
    'running',
    'pending',
    'suspended',
    'completed',
  ] as const)
    bg.tasks.set(status, task(status, thread.id, status));
  bg.tasks.set('foreign-thread', task('foreign-thread', 'another-thread'));
  bg.tasks.set(
    'foreign-resource',
    task('foreign-resource', thread.id, 'running', 'user:bob'),
  );
  const cancel = t.mock.method(bg.manager, 'cancel');
  let tasks: ThreadBackgroundTask[] = [];
  await service.subscribe('alice', thread.id, (snapshot) => {
    tasks = snapshot.backgroundTasks ?? [];
  });
  await service.run('alice', thread.id, {
    ...settings,
    id: 'message01',
    parts: [{ type: 'text', text: 'foreground' }],
    isImmediate: false,
  });
  await until(() => started);
  await assert.rejects(
    service.cancelBackgroundTask('bob', thread.id, 'running'),
    { code: 'THREAD_NOT_FOUND' },
  );
  for (const id of ['missing', 'foreign-thread', 'foreign-resource'])
    await assert.rejects(service.cancelBackgroundTask('alice', thread.id, id), {
      code: 'BACKGROUND_TASK_NOT_FOUND',
    });
  assert.equal(cancel.mock.callCount(), 0);
  for (const status of [
    'running',
    'pending',
    'suspended',
    'completed',
  ] as const) {
    await service.cancelBackgroundTask('alice', thread.id, status);
    await service.cancelBackgroundTask('alice', thread.id, status);
    await until(
      () =>
        tasks.find((item) => item.id === status)?.status ===
        (status === 'completed' ? 'completed' : 'cancelled'),
    );
  }
  assert.equal(foregroundSignal?.aborted, false);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.status,
    'running',
  );
  assert.equal(bg.tasks.get('foreign-thread')?.status, 'running');
  assert.equal(bg.tasks.get('foreign-resource')?.status, 'running');
});

test('project task cancellation respects membership and reports native cancellation failures', async (t) => {
  const { memory } = fakeMemory();
  const bg = fakeManager();
  const members = new Set(['alice', 'bob']);
  const service = new ThreadService(
    memory,
    runner,
    {
      async assertMember(userId) {
        if (!members.has(userId)) throw new Error('PROJECT_NOT_FOUND');
        return { role: 'member' };
      },
    },
    bg.manager,
  );
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', {
    ...settings,
    projectId: 'project123456789',
  });
  bg.tasks.set(
    'shared',
    task('shared', thread.id, 'running', 'project:project123456789'),
  );
  await service.getThread('alice', thread.id);
  const cancel = t.mock.method(bg.manager, 'cancel', async () => {
    throw new Error('Storage unavailable');
  });
  await assert.rejects(
    service.cancelBackgroundTask('bob', thread.id, 'shared'),
    /Storage unavailable/,
  );
  assert.equal(
    (await service.getThread('alice', thread.id)).backgroundTasks?.[0].status,
    'running',
  );
  cancel.mock.restore();
  members.delete('bob');
  await assert.rejects(
    service.cancelBackgroundTask('bob', thread.id, 'shared'),
    /PROJECT_NOT_FOUND/,
  );
  assert.equal(bg.tasks.get('shared')?.status, 'running');
  members.add('bob');
  await service.cancelBackgroundTask('bob', thread.id, 'shared');
  assert.equal(
    (await service.getThread('alice', thread.id)).backgroundTasks?.[0].status,
    'cancelled',
  );
});
