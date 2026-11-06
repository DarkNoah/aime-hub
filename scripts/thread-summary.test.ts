import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../apps/server/src/app.js';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';

const settings = {
  model: 'provider/model',
  agentId: 'code:assistant',
  reasoningEffort: 'high',
} as const;
const runner = {
  async validate() {},
  async createWorkspace() {
    return '/tmp/thread-summary';
  },
  async open() {
    throw new Error('Summary must not open a session');
  },
  async getGoal() {
    throw new Error('Summary must not hydrate runtime state');
  },
};

test('summary RPC reads settings without history and enforces session, ownership and archive access', async (t) => {
  const { memory, threads } = fakeMemory();
  const service = new ThreadService(memory, runner);
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  t.mock.method(memory, 'recall', async () => {
    throw new Error('History is unavailable');
  });
  let userId: string | undefined;
  const auth = {
    api: {
      getSession: async () =>
        userId ? { user: { id: userId, role: 'user' } } : null,
    },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, {
    threads: service,
    models: {} as never,
    webOrigin: 'http://localhost:5173',
  });
  const client = createApiClient(() => 'http://localhost/api/rpc');
  t.mock.method(globalThis, 'fetch', (request: Request) => {
    const headers = new Headers(request.headers);
    headers.set('origin', 'http://localhost:5173');
    return app.request(new Request(request, { headers }));
  });
  const read = () =>
    client.threads.summary({ params: { threadId: thread.id } });
  await assert.rejects(read, { code: 'UNAUTHORIZED' });
  userId = 'alice';
  assert.deepEqual(await read(), JSON.parse(JSON.stringify(thread)));
  assert.deepEqual(
    await (await app.request(`/api/threads/${thread.id}/summary`)).json(),
    JSON.parse(JSON.stringify(thread)),
  );
  userId = 'bob';
  await assert.rejects(read, { code: 'THREAD_NOT_FOUND' });
  userId = 'alice';
  threads.get(thread.id)!.metadata!.archivedAt = new Date().toISOString();
  await assert.rejects(read, { code: 'THREAD_NOT_FOUND' });
});

test(
  'summary reads do not wait behind a large history load',
  { timeout: 5000 },
  async (t) => {
    const { memory } = fakeMemory();
    const service = new ThreadService(memory, {
      ...runner,
      getGoal: undefined,
    });
    const thread = await service.createThread('alice', settings);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const recall = memory.recall;
    t.mock.method(
      memory,
      'recall',
      async (args: Parameters<typeof recall>[0]) => {
        started();
        await gate;
        return recall(args);
      },
    );
    const loading = service.getThread('alice', thread.id);
    t.after(async () => {
      release();
      await loading;
      await service.shutdown();
    });
    await reading;
    assert.deepEqual(
      await service.getThreadSummary('alice', thread.id),
      thread,
    );
    release();
    assert.deepEqual((await loading).thread, thread);
  },
);

test('summary revalidates project membership and plugin access', async (t) => {
  const { memory } = fakeMemory();
  const members = new Set(['alice', 'bob']);
  let pluginEnabled = true;
  const service = new ThreadService(
    memory,
    {
      ...runner,
      async assertPluginAccess() {
        if (!pluginEnabled) throw new ThreadError('FORBIDDEN', 403);
      },
    },
    {
      async assertMember(userId) {
        if (!members.has(userId))
          throw new ThreadError('PROJECT_NOT_FOUND', 404);
        return { role: 'member' };
      },
    },
  );
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', {
    ...settings,
    projectId: 'project000000001',
    plugin: 'vibe-quant',
  });
  assert.deepEqual(await service.getThreadSummary('bob', thread.id), thread);
  members.delete('bob');
  await assert.rejects(
    service.getThreadSummary('bob', thread.id),
    /PROJECT_NOT_FOUND/,
  );
  pluginEnabled = false;
  await assert.rejects(
    service.getThreadSummary('alice', thread.id),
    /FORBIDDEN/,
  );
});

test('summary uses the live run status without reloading history', async (t) => {
  const { memory } = fakeMemory();
  const service = new ThreadService(memory, {
    ...runner,
    getGoal: undefined,
    async open({ onEvent }) {
      return sessionStub({
        async send() {
          onEvent({ type: 'status', status: 'running', runId: 'run' });
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, {
    ...settings,
    id: 'input-1',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Hello' }],
  });
  const snapshot = await service.getThread('alice', thread.id);
  assert.equal(snapshot.thread.status, 'running');
  t.mock.method(memory, 'recall', async () => {
    throw new Error('History must not be reloaded');
  });
  assert.deepEqual(
    await service.getThreadSummary('alice', thread.id),
    snapshot.thread,
  );
});
