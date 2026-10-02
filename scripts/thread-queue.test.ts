import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import { createApp } from '../apps/server/src/app.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { runInputSchema, type RunInput } from '@aime/shared/threads';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = (id: string): RunInput => ({
  ...settings,
  id,
  parts: [{ type: 'text', text: id }],
  isImmediate: false,
});
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const store = fakeMemory();
  const contexts: Parameters<ChatRunner['execute']>[0][] = [];
  const releases: (() => void)[] = [];
  const service = new ThreadService(store.memory, {
    async validate() {},
    async createWorkspace() {
      return '/tmp/queue-test';
    },
    async execute(context) {
      contexts.push(context);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        if (context.signal.aborted) resolve();
        else
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input('active001'));
  await service.run('alice', thread.id, input('queued001'));
  await service.run('alice', thread.id, input('queued002'));
  await service.run('alice', thread.id, input('queued003'));
  return { ...store, service, thread, contexts, releases };
}
const gone = (error: unknown) =>
  error instanceof ThreadError && error.code === 'QUEUED_MESSAGE_NOT_FOUND';

test('queue edits use full text, preserve attachments and identity, and change immediate injection', async (t) => {
  const { service, thread, contexts, messages } = await fixture(t);
  const original = {
    ...input('queued004'),
    createdBy: 'alice',
    parts: [
      { type: 'text' as const, text: 'original '.repeat(100) },
      {
        type: 'file' as const,
        mediaType: 'image/png' as const,
        url: 'data:image/png;base64,YQ==',
      },
    ],
  };
  await service.run('alice', thread.id, original);
  const detail = await service.getQueued('alice', thread.id, original.id);
  assert.equal(detail.text, 'original '.repeat(100));
  assert.equal(detail.hasAttachments, true);
  const updated = 'changed '.repeat(100).trim();
  await service.updateQueued('alice', thread.id, original.id, {
    text: updated,
    isImmediate: true,
  });
  await service.updateQueued('alice', thread.id, 'queued002', {
    isImmediate: true,
  });
  await service.updateQueued('alice', thread.id, 'queued002', {
    isImmediate: false,
  });
  const immediate = await contexts[0].takeImmediate();
  assert.deepEqual(
    immediate.map((item) => item.id),
    [original.id],
  );
  assert.equal(immediate[0].createdBy, 'alice');
  assert.equal(immediate[0].model, original.model);
  assert.deepEqual(immediate[0].parts, [
    original.parts[1],
    { type: 'text', text: updated },
  ]);
  assert.ok(messages.has(original.id));
  await assert.rejects(
    service.updateQueued('alice', thread.id, original.id, { text: 'too late' }),
    gone,
  );
  await assert.rejects(
    service.moveQueued('alice', thread.id, original.id, null),
    gone,
  );
});

test('queue reorder determines execution order and preserves concurrent additions', async (t) => {
  const { service, thread, contexts, releases } = await fixture(t);
  await Promise.all([
    service.moveQueued('alice', thread.id, 'queued003', 'queued001'),
    service.run('alice', thread.id, input('queued004')),
  ]);
  assert.deepEqual(
    (await service.getThread('alice', thread.id)).thread.queue.map(
      (item) => item.id,
    ),
    ['queued003', 'queued001', 'queued002', 'queued004'],
  );
  await service.moveQueued('alice', thread.id, 'queued001', null);
  await service.cancelQueued('alice', thread.id, 'queued002');
  await assert.rejects(
    service.moveQueued('alice', thread.id, 'queued004', 'queued002'),
    gone,
  );
  for (let index = 0; index < 3; index++) {
    releases[index]();
    for (let tries = 0; contexts.length < index + 2 && tries < 200; tries++)
      await delay(5);
    assert.equal(contexts.length, index + 2);
  }
  assert.deepEqual(
    contexts.map((context) => context.input.id),
    ['active001', 'queued003', 'queued004', 'queued001'],
  );
});

test('queue writes validate content, enforce ownership, and roll back failed persistence', async (t) => {
  const { service, memory, thread } = await fixture(t);
  for (const operation of [
    () => service.getQueued('bob', thread.id, 'queued001'),
    () =>
      service.updateQueued('bob', thread.id, 'queued001', { text: 'stolen' }),
    () => service.moveQueued('bob', thread.id, 'queued001', null),
  ])
    await assert.rejects(
      operation,
      (error) =>
        error instanceof ThreadError && error.code === 'THREAD_NOT_FOUND',
    );
  await assert.rejects(
    service.updateQueued('alice', thread.id, 'queued001', { text: ' ' }),
  );
  await assert.rejects(
    service.updateQueued('alice', thread.id, 'queued001', {
      text: 'x'.repeat(60001),
    }),
  );
  await assert.rejects(
    service.updateQueued('alice', thread.id, 'active001', { text: 'running' }),
    gone,
  );
  const before = (await service.getThread('alice', thread.id)).thread.queue;
  const updateThread = memory.updateThread;
  memory.updateThread = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(
    service.updateQueued('alice', thread.id, 'queued001', {
      text: 'not saved',
      isImmediate: true,
    }),
  );
  await assert.rejects(
    service.moveQueued('alice', thread.id, 'queued001', null),
  );
  memory.updateThread = updateThread;
  assert.deepEqual(
    (await service.getThread('alice', thread.id)).thread.queue,
    before,
  );
  assert.equal(runInputSchema.parse(input('queued005')).isImmediate, false);
});

test('queue edits remain paused until resumed and persist across runtime restart', async (t) => {
  const { service, thread, memory } = await fixture(t);
  await service.abort('alice', thread.id);
  await service.shutdown();
  const restored = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return '/tmp/test';
    },
    async execute() {
      throw new Error('Must stay paused');
    },
  });
  t.after(() => restored.shutdown());
  await restored.updateQueued('alice', thread.id, 'queued001', {
    text: 'edited while paused',
    isImmediate: true,
  });
  await restored.moveQueued('alice', thread.id, 'queued003', 'queued001');
  const state = await restored.getThread('alice', thread.id);
  assert.equal(state.thread.status, 'idle');
  assert.deepEqual(
    state.thread.queue.map((item) => item.id),
    ['queued003', 'queued001', 'queued002'],
  );
  assert.equal(state.thread.queue[1].isImmediate, true);
  assert.equal(state.thread.queue[1].text, 'edited while paused');
});

test('queue HTTP routes validate patches and share the locked mutation path', async (t) => {
  const { service, thread } = await fixture(t);
  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const id = headers.get('x-test-user');
        return id ? { user: { id }, session: { id: 'test-session' } } : null;
      },
    },
  } as unknown as Parameters<typeof createApp>[0];
  const origin = 'http://localhost:5173';
  const server = createServer(
    createApp(auth, undefined, {
      threads: service,
      models: {} as never,
      webOrigin: origin,
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/threads/${thread.id}/queue`;
  const request = (path: string, method: string, body?: object) =>
    fetch(base + path, {
      method,
      headers: {
        'x-test-user': 'alice',
        origin,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await fetch(base + '/queued001')).status, 401);
  assert.equal((await request('/queued001', 'GET')).status, 200);
  assert.equal(
    (await request('/queued001', 'PATCH', { parts: [] })).status,
    400,
  );
  assert.equal((await request('/queued001', 'PATCH', {})).status, 400);
  assert.equal(
    (
      await request('/queued001', 'PATCH', {
        text: 'updated',
        isImmediate: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('', 'PATCH', { id: 'queued003', beforeId: 'queued001' }))
      .status,
    200,
  );
  assert.equal(
    (await request('/active001', 'PATCH', { text: 'late' })).status,
    409,
  );
  const detail = await (await request('/queued001', 'GET')).json();
  assert.equal(detail.text, 'updated');
  assert.equal(detail.isImmediate, true);
});
