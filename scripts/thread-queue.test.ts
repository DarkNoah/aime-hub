import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { createApp } from '../apps/server/src/app.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';
import type { RunInput } from '@aime/shared/threads';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = (id: string): RunInput => ({
  ...settings,
  id,
  parts: [{ type: 'text', text: id }],
  isImmediate: false,
});

test('input is handed to the native session once; counts and clear are native events', async (t) => {
  const { memory, threads } = fakeMemory();
  const received: RunInput[] = [];
  let clearCalls = 0;
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return 'workspace';
    },
    async open({ onEvent }) {
      return sessionStub({
        async send(value) {
          received.push(value);
          onEvent({ type: 'queue', count: 7 });
        },
        clearQueue() {
          clearCalls++;
          onEvent({ type: 'queue', count: 0 });
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await Promise.all([
    service.run('alice', thread.id, input('message01')),
    service.run('alice', thread.id, input('message01')),
  ]);
  await delay(0);
  assert.equal(received.length, 1);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.queueCount,
    7,
  );
  assert.equal(threads.get(thread.id)?.metadata?.queue, undefined);
  await assert.rejects(service.clearQueue('bob', thread.id), {
    code: 'THREAD_NOT_FOUND',
  });
  await service.clearQueue('alice', thread.id);
  await delay(0);
  assert.equal(clearCalls, 1);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.queueCount,
    0,
  );

  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const id = headers.get('x-test-user');
        return id ? { user: { id }, session: { id: 'session' } } : null;
      },
    },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, {
    threads: service,
    models: {} as never,
    webOrigin: 'http://localhost:5173',
  });
  const path = `/api/threads/${thread.id}/queue`;
  assert.equal((await app.request(path, { method: 'DELETE' })).status, 401);
  const headers = { 'x-test-user': 'alice', origin: 'http://localhost:5173' };
  assert.equal(
    (await app.request(path, { method: 'DELETE', headers })).status,
    200,
  );
  assert.equal(
    (
      await app.request(`/api/threads/${thread.id}/resume`, {
        method: 'POST',
        headers,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request(path + '/message01', {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [] }),
      })
    ).status,
    400,
  );
});

test('legacy drafts are handed off once and a rejected handoff preserves the remaining drafts', async (t) => {
  const { memory, threads } = fakeMemory();
  const accepted: string[] = [];
  let fail = true;
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return 'workspace';
    },
    async open() {
      return sessionStub({
        async send(value) {
          if (value.id === 'legacy02' && fail)
            throw new Error('temporarily unavailable');
          accepted.push(value.id);
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  threads.get(thread.id)!.metadata!.queue = [
    input('legacy01'),
    input('legacy02'),
  ];
  await assert.rejects(
    service.run('alice', thread.id, input('message01')),
    /temporarily unavailable/,
  );
  assert.deepEqual(accepted, ['legacy01']);
  assert.deepEqual(
    (threads.get(thread.id)!.metadata!.queue as RunInput[]).map(
      (item) => item.id,
    ),
    ['legacy02'],
  );
  fail = false;
  await service.run('alice', thread.id, input('message01'));
  assert.deepEqual(accepted, ['legacy01', 'legacy02', 'message01']);
  assert.equal(threads.get(thread.id)?.metadata?.queue, undefined);
});
