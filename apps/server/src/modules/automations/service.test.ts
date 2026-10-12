import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresStore } from '@mastra/pg';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import {
  automationInputSchema,
  automationScopeSchema,
} from '@aime/shared/automations';
import { createApp } from '../../app.js';
import { createApiClient } from '../../../../web/src/lib/rpc.js';
import {
  fixture,
  input,
  personal,
  project,
  system,
  until,
} from './test-fixture.js';
import {
  automationAgentId,
  legacyWorkflowId,
  systemTimezone,
} from './metadata.js';
import { threadId } from '../../../../../packages/shared/src/rpc/base.js';
import type { ThreadNavigationEvent } from '@aime/shared/threads';

// Scope and ownership are server-owned; the client controls visibility only.
test('input rejects timezone and caller-supplied thread identities', () => {
  for (const patch of [
    { timezone: 'UTC' },
    { threadId: 'other' },
    { resourceId: 'user:bob' },
    { ownerId: 'bob' },
    { prompt: ' ' },
  ])
    assert.equal(
      automationInputSchema.safeParse({ ...input, ...patch }).success,
      false,
    );
  assert.equal(
    automationScopeSchema.safeParse({
      scope: 'personal',
      projectId: project.projectId,
    }).success,
    false,
  );
  assert.equal(threadId.safeParse('schedule:1234567890123456').success, true);
  assert.equal(threadId.safeParse('schedule:../../secret').success, false);
});

test('scope permissions and visibility updates preserve the original thread and paginate after filtering', async (t) => {
  const { service, memory, threads } = await fixture(t);
  const mine = await service.create('alice', personal, input);
  const shared = await service.create('owner', project, input);
  const global = await service.create('admin', system, {
    ...input,
    separateThread: true,
  });
  assert.equal(mine.timezone, systemTimezone());
  for (const task of [mine, shared, global]) await service.prepare(task.id);
  assert.equal((await threads.listThreads('alice')).threads.length, 0);
  assert.equal(
    (await threads.listThreads('member', 0, project.projectId)).threads.length,
    0,
  );
  assert.equal(
    (await threads.listThreads('admin')).threads[0].id,
    global.threadId,
  );
  assert.equal((await threads.listThreads('bob')).threads.length, 0);
  for (const call of [
    () => service.update('bob', mine.id, input),
    () => service.run('bob', mine.id),
    () => service.history('bob', mine.id),
    () => service.remove('bob', mine.id),
    () => service.setEnabled('bob', mine.id, true),
    () => service.list('bob', system),
    () => service.create('member', project, input),
    () => service.update('member', shared.id, input),
    () => service.run('member', shared.id),
    () => threads.getThread('alice', global.threadId),
  ])
    await assert.rejects(call);
  assert.equal((await service.list('member', project)).canManage, false);
  const visible = await service.update('alice', mine.id, {
    ...input,
    separateThread: true,
    name: 'Visible task',
    settings: { ...input.settings, reasoningEffort: 'high' },
  });
  assert.equal(visible.threadId, mine.threadId);
  assert.equal(
    (await threads.getThread('alice', mine.threadId)).thread.reasoningEffort,
    'high',
  );
  assert.equal(
    (await threads.listThreads('alice', 0, undefined, 1)).threads[0].id,
    mine.threadId,
  );
  await service.update('owner', shared.id, { ...input, separateThread: true });
  assert.equal(
    (await threads.listThreads('member', 0, project.projectId)).threads[0].id,
    shared.threadId,
  );
  await service.update('alice', mine.id, input);
  assert.equal((await threads.listThreads('alice')).threads.length, 0);
  assert.ok(await memory.getThreadById({ threadId: mine.threadId }));
  await service.remove('alice', mine.id);
  assert.equal((await service.list('alice', personal)).items.length, 0);
  assert.ok(await memory.getThreadById({ threadId: mine.threadId }));
});

test('validation runs before creating a thread and manual runs preserve paused cadence', async (t) => {
  const { service, mastra, memory } = await fixture(t);
  for (const cron of ['invalid cron', '0 0 0 1 1 * 2000'])
    await assert.rejects(
      () => service.create('alice', personal, { ...input, cron }),
      { code: 'AUTOMATION_CRON_INVALID' },
    );
  assert.equal(
    (
      await memory.listThreads({
        filter: { resourceId: 'user:alice' },
        perPage: false,
      })
    ).threads.length,
    0,
  );
  const task = await service.create('alice', personal, input);
  const before = await mastra.schedules.get(task.id);
  await service.run('alice', task.id);
  await until(
    () => service.history('alice', task.id),
    (rows) => rows[0]?.status === 'succeeded',
  );
  assert.equal((await mastra.schedules.get(task.id))?.status, 'paused');
  assert.equal(
    (await mastra.schedules.get(task.id))?.nextFireAt,
    before?.nextFireAt,
  );
  await service.setEnabled('alice', task.id, true);
  assert.equal(
    (await service.setEnabled('alice', task.id, false)).nextFireAt,
    null,
  );
});

test('saving, editing, toggling and deleting unstarted tasks never create threads or workspaces', async (t) => {
  const { service, memory, threads, root } = await fixture(t);
  for (const scope of [personal, project, system]) {
    const user = scope.scope === 'personal' ? 'alice' : 'admin';
    const task = await service.create(user, scope, {
      ...input,
      separateThread: true,
    });
    assert.equal(task.threadCreated, false);
    await service.update(user, task.id, {
      ...input,
      name: 'Edited before first run',
      separateThread: true,
    });
    await service.setEnabled(user, task.id, true);
    await service.setEnabled(user, task.id, false);
    assert.equal(await memory.getThreadById({ threadId: task.threadId }), null);
    assert.equal(
      (
        await threads.listThreads(
          user,
          0,
          scope.scope === 'project' ? scope.projectId : undefined,
        )
      ).threads.length,
      0,
    );
    await service.remove(user, task.id);
  }
  assert.deepEqual(await readdir(root), []);
});

test('concurrent first starts create one thread and edits preserve the creation marker', async (t) => {
  const { service, memory } = await fixture(t);
  const create = t.mock.method(memory, 'createThread');
  const task = await service.create('alice', personal, input);
  const results = await Promise.all([
    service.prepare(task.id),
    service.prepare(task.id),
    service.update('alice', task.id, {
      ...input,
      name: 'Latest title',
      separateThread: true,
    }),
    service.prepare(task.id),
  ]);
  assert.equal(create.mock.callCount(), 1);
  assert.ok(
    results.every(
      (result) => result.threadId === task.threadId && result.threadCreated,
    ),
  );
  assert.equal(
    (await memory.getThreadById({ threadId: task.threadId }))?.title,
    'Latest title',
  );
  await memory.deleteThread(task.threadId);
  await assert.rejects(() => service.prepare(task.id), {
    code: 'AUTOMATION_THREAD_UNAVAILABLE',
  });
});

test('retrying the first start after a metadata failure keeps the already created thread', async (t) => {
  const { service, memory, mastra } = await fixture(t);
  const task = await service.create('alice', personal, input);
  const create = t.mock.method(memory, 'createThread');
  const update = t.mock.method(mastra.schedules, 'update', async () => {
    throw new Error('metadata unavailable');
  });
  await assert.rejects(() => service.prepare(task.id), /metadata unavailable/);
  const existing = await memory.getThreadById({ threadId: task.threadId });
  assert.ok(existing);
  update.mock.restore();
  assert.equal((await service.prepare(task.id)).threadCreated, true);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(
    (await memory.getThreadById({ threadId: task.threadId }))?.metadata
      ?.workspace,
    existing.metadata?.workspace,
  );
});

test('navigation snapshots follow visibility changes and system thread archives stay admin-only', async (t) => {
  const { service, threads } = await fixture(t);
  const task = await service.create('alice', personal, input);
  const shared = await service.create('owner', project, {
    ...input,
    separateThread: true,
  });
  const global = await service.create('admin', system, {
    ...input,
    separateThread: true,
  });
  for (const item of [task, shared, global]) await service.prepare(item.id);
  const events = new Map<string, ThreadNavigationEvent[]>();
  for (const user of ['alice', 'member', 'admin']) {
    const rows: ThreadNavigationEvent[] = [];
    events.set(user, rows);
    const unsubscribe = threads.subscribeNavigation(
      user,
      (event) => rows.push(event),
      () => {},
    );
    t.after(unsubscribe);
  }
  const snapshot = (user: string) =>
    [...events.get(user)!].reverse().find((event) => event.type === 'snapshot');
  await until(async () => snapshot('member'), Boolean);
  assert.ok(
    snapshot('member')!.threads.some((thread) => thread.id === shared.threadId),
  );
  assert.ok(
    !snapshot('member')!.threads.some(
      (thread) => thread.id === global.threadId,
    ),
  );
  await until(async () => snapshot('alice'), Boolean);
  assert.ok(
    !snapshot('alice')!.threads.some((thread) => thread.id === task.threadId),
  );
  await service.update('alice', task.id, { ...input, separateThread: true });
  await until(
    async () =>
      snapshot('alice')?.threads.some((thread) => thread.id === task.threadId),
    Boolean,
  );
  await service.update('alice', task.id, input);
  await until(
    async () =>
      !snapshot('alice')?.threads.some((thread) => thread.id === task.threadId),
    Boolean,
  );
  await threads.deleteThread('admin', global.threadId);
  assert.equal(
    (await threads.listArchivedThreads('admin'))[0].id,
    global.threadId,
  );
  assert.deepEqual(await threads.listArchivedThreads('alice'), []);
  await assert.rejects(() => threads.restoreThread('alice', global.threadId), {
    code: 'THREAD_NOT_FOUND',
  });
  await threads.restoreThread('admin', global.threadId);
  assert.equal(
    (await threads.listThreads('admin')).threads[0].id,
    global.threadId,
  );
});

test('native cron execution rechecks revoked creator permissions before resolving a model', async (t) => {
  const { service, mastra, store, users, members, calls } = await fixture(t);
  const tasks = [
    await service.create('alice', personal, input),
    await service.create('owner', project, input),
    await service.create('admin', system, input),
  ];
  users.get('alice')!.banned = true;
  members.delete('owner');
  users.get('admin')!.role = 'user';
  const before = calls.length;
  const schedules = (await store.getStore('schedules'))!;
  for (const task of tasks) {
    // Bypass the HTTP authorization layer, as a cron worker does.
    await mastra.schedules.run(task.id);
    const triggers = await until(
      () => schedules.listTriggers(task.id),
      (rows) => rows.length > 0,
    );
    assert.equal(triggers[0].outcome, 'failed');
  }
  assert.equal(calls.length, before);
});

test('native threaded scheduling skips overlapping runs and records sanitized failures', async (t) => {
  const model = createMockModel({ mockText: 'Completed', version: 'v2' });
  assert.ok(model.specificationVersion === 'v2');
  const original = model.doStream.bind(model);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let entered = false;
  t.mock.method(
    model,
    'doStream',
    async (options: Parameters<typeof original>[0]) => {
      entered = true;
      await blocked;
      return original(options);
    },
  );
  const { service } = await fixture(t, { model });
  const task = await service.create('alice', personal, input);
  await service.run('alice', task.id);
  await until(async () => entered, Boolean);
  await service.run('alice', task.id);
  await until(
    () => service.history('alice', task.id),
    (rows) => rows.some((row) => row.status === 'skipped'),
  );
  release();
  await until(
    () => service.history('alice', task.id),
    (rows) => rows.some((row) => row.status === 'succeeded'),
  );
  t.mock.method(model, 'doStream', async () => {
    throw new Error('secret-provider-body');
  });
  await service.run('alice', task.id);
  const runs = await until(
    () => service.history('alice', task.id),
    (rows) => rows.some((row) => row.status === 'failed'),
  );
  assert.equal(
    runs.find((row) => row.status === 'failed')?.error,
    'AUTOMATION_RUN_FAILED',
  );
  assert.ok(!JSON.stringify(runs).includes('secret-provider-body'));
});

test('archived or deleted task threads cannot silently be recreated', async (t) => {
  const { service, memory, threads, mastra } = await fixture(t);
  const task = await service.create('alice', personal, {
    ...input,
    separateThread: true,
  });
  await service.prepare(task.id);
  // Older eagerly-created v2 schedules have no explicit creation marker.
  const row = (await mastra.schedules.get(task.id))!;
  const metadata = { ...row.metadata };
  delete metadata.threadCreated;
  await mastra.schedules.update(task.id, { metadata });
  assert.equal(
    (await service.list('alice', personal)).items[0].threadCreated,
    true,
  );
  await threads.deleteThread('alice', task.threadId);
  await assert.rejects(() => service.run('alice', task.id), {
    code: 'AUTOMATION_THREAD_UNAVAILABLE',
  });
  await threads.restoreThread('alice', task.threadId);
  await service.run('alice', task.id);
  await until(
    () => service.history('alice', task.id),
    (rows) => rows[0]?.status === 'succeeded',
  );
  await memory.deleteThread(task.threadId);
  await assert.rejects(() => service.setEnabled('alice', task.id, true), {
    code: 'AUTOMATION_THREAD_UNAVAILABLE',
  });
});

test('legacy workflow tasks upgrade in place once and retain their trigger records', async (t) => {
  const { service, store, mastra, memory } = await fixture(t);
  const schedules = (await store.getStore('schedules'))!;
  const id = 'schedule_legacy-task';
  await schedules.createSchedule({
    id,
    target: {
      type: 'workflow',
      workflowId: legacyWorkflowId,
      resourceId: 'automation:user:alice',
      inputData: { id },
    },
    cron: input.cron,
    timezone: 'Pacific/Honolulu',
    status: 'paused',
    nextFireAt: Date.now() + 100000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      managedBy: 'automations',
      version: 1,
      ownerId: 'alice',
      scope: personal,
      data: { ...input, timezone: 'Pacific/Honolulu' },
    },
  });
  await schedules.recordTrigger({
    scheduleId: id,
    runId: 'old-run',
    actualFireAt: Date.now(),
    scheduledFireAt: Date.now(),
    outcome: 'failed',
  });
  await service.initialize();
  await mastra.startWorkers();
  const upgraded = (await service.list('alice', personal)).items[0];
  assert.equal(upgraded.id, id);
  assert.equal(upgraded.timezone, systemTimezone());
  assert.equal((await mastra.schedules.get(id))?.agentId, automationAgentId);
  assert.equal((await service.history('alice', id)).length, 1);
  await service.initialize();
  assert.equal(
    (await service.list('alice', personal)).items[0].threadId,
    upgraded.threadId,
  );
  assert.equal(
    (
      await memory.listThreads({
        filter: { resourceId: 'user:alice' },
        perPage: false,
      })
    ).threads.length,
    0,
  );
  await service.run('alice', id);
  await until(
    () => service.history('alice', id),
    (rows) => rows.some((row) => row.status === 'succeeded'),
  );
});

test('RPC supports schedule-prefixed thread IDs and enforces ownership and origins', async (t) => {
  const { service, threads } = await fixture(t);
  const task = await service.create('alice', personal, {
    ...input,
    separateThread: true,
  });
  const app = createApp(
    {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const id = headers.get('x-test-user');
          return id ? { user: { id, role: 'user' }, session: { id } } : null;
        },
      },
    } as Parameters<typeof createApp>[0],
    undefined,
    { threads, models: {} as never, webOrigin: 'http://localhost' },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { service, webOrigin: 'http://localhost' },
  );
  let currentUser = 'alice';
  let currentOrigin = 'http://localhost';
  t.mock.method(globalThis, 'fetch', (request: Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? request.headers);
    headers.set('x-test-user', currentUser);
    headers.set('origin', currentOrigin);
    return app.fetch(new Request(request, { ...init, headers }));
  });
  const client = createApiClient(() => 'http://localhost/api/rpc');
  assert.equal(
    (await client.automations.run({ id: task.id })).threadCreated,
    true,
  );
  assert.equal(
    (await client.threads.get({ params: { threadId: task.threadId } })).thread
      .id,
    task.threadId,
  );
  currentUser = 'bob';
  await assert.rejects(
    () => client.threads.get({ params: { threadId: task.threadId } }),
    { code: 'THREAD_NOT_FOUND' },
  );
  await assert.rejects(() => client.automations.run({ id: task.id }), {
    code: 'AUTOMATION_NOT_FOUND',
  });
  currentUser = 'alice';
  currentOrigin = 'http://evil.example';
  await assert.rejects(() => client.automations.run({ id: task.id }), {
    code: 'FORBIDDEN',
  });
});

test(
  'PostgreSQL thread, schedule and run results survive runtime recreation',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schemaName = `automations_test_${randomBytes(8).toString('hex')}`;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    let first: Awaited<ReturnType<typeof fixture>> | undefined;
    let second: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      first = await fixture(t, {
        store: new PostgresStore({ id: 'thread-test', pool, schemaName }),
      });
      const task = await first.service.create('alice', personal, {
        ...input,
        separateThread: true,
      });
      const pending = await first.service.create('alice', personal, input);
      await first.service.run('alice', task.id);
      await until(
        () => first!.service.history('alice', task.id),
        (rows) => rows[0]?.status === 'succeeded',
      );
      await first.shutdown();
      await first.threads.shutdown();
      await first.mastra.shutdown();
      second = await fixture(t, {
        workspaceRoot: first.root,
        store: new PostgresStore({
          id: 'thread-restart-test',
          pool,
          schemaName,
        }),
      });
      assert.equal(
        (await second.service.list('alice', personal)).items.find(
          (item) => item.id === task.id,
        )!.threadId,
        task.threadId,
      );
      assert.equal(
        await second.memory.getThreadById({ threadId: pending.threadId }),
        null,
      );
      assert.equal(
        (await second.service.run('alice', pending.id)).threadCreated,
        true,
      );
      assert.equal(
        (await second.service.history('alice', task.id))[0].text,
        'Native generated result',
      );
      assert.equal(
        (
          await second.threads.getThread('alice', task.threadId)
        ).messages.filter((message) => message.role === 'assistant').length,
        1,
      );
      await second.service.run('alice', task.id);
      await until(
        () => second!.service.history('alice', task.id),
        (rows) => rows.filter((row) => row.status === 'succeeded').length === 2,
      );
      assert.equal(
        (
          await second.threads.getThread('alice', task.threadId)
        ).messages.filter((message) => message.role === 'assistant').length,
        2,
      );
    } finally {
      await first?.shutdown();
      await first?.mastra.shutdown();
      await second?.shutdown();
      await second?.mastra.shutdown();
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  },
);
