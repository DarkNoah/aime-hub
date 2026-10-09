import { sessionStub } from './fixtures/thread-session.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ThreadNavigationEvent,
  ThreadStatus,
  ThreadStreamStatus,
} from '@aime/shared/threads';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = {
  ...settings,
  id: 'message01',
  isImmediate: false,
  parts: [{ type: 'text', text: 'Hello' }] as { type: 'text'; text: string }[],
};
const base = {
  async validate() {},
  async createWorkspace() {
    return 'workspace';
  },
};
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error('Expected thread status was not received');
}

for (const status of [
  'success',
  'suspended',
  'failed',
  'canceled',
  'tripwire',
  'bailed',
  'paused',
  'skipped',
  'waiting',
] satisfies ThreadStreamStatus[]) {
  test(`native ${status} status survives cleanup, navigation SSE and reopening`, async (t) => {
    const { memory, threads } = fakeMemory();
    let context: Parameters<ChatRunner['open']>[0] | undefined;
    let finish!: () => void;
    const runner: ChatRunner = {
      ...base,
      async open(value) {
        context = value;
        finish = () => value.onEvent({ type: 'status', status, runId: 'run' });
        return sessionStub({
          async send() {
            value.onEvent({ type: 'status', status: 'running', runId: 'run' });
          },
        });
      },
    };
    const service = new ThreadService(memory, runner);
    t.after(async () => {
      finish?.();
      await service.shutdown();
    });
    const thread = await service.createThread('alice', settings);
    assert.equal(thread.status, 'idle');
    const snapshots: ThreadStatus[] = [];
    await service.subscribe('alice', thread.id, (snapshot) =>
      snapshots.push(snapshot.thread.status),
    );
    const events: ThreadNavigationEvent[] = [];
    service.subscribeNavigation(
      'alice',
      (event) => events.push(event),
      () => {},
    );
    await until(() => events.length > 0);
    await service.run('alice', thread.id, input);
    await until(() => !!context && snapshots.includes('running'));
    finish();
    await until(
      () =>
        threads.get(thread.id)?.metadata?.status === status &&
        threads.get(thread.id)?.metadata?.activeId === null,
    );
    await until(() =>
      events.some(
        (event) => event.type === 'upsert' && event.thread.status === status,
      ),
    );
    assert.equal(
      (await service.getThread('alice', thread.id)).thread.status,
      status,
    );
    assert.equal(
      (await service.listThreads('alice')).threads[0].status,
      status,
    );
    assert.equal(snapshots.at(-1), status);
    await service.shutdown();
    const reopened = new ThreadService(memory, runner);
    t.after(() => reopened.shutdown());
    assert.equal(
      (await reopened.listThreads('alice')).threads[0].status,
      status,
    );
    assert.equal(
      (await reopened.getThread('alice', thread.id)).thread.status,
      status,
    );
  });
}

test('stop clears native pending input and ignores a late cancellation error', async (t) => {
  const { memory, threads } = fakeMemory();
  let aborts = 0;
  const service = new ThreadService(memory, {
    ...base,
    async open({ onEvent }) {
      return sessionStub({
        async send() {
          onEvent({ type: 'status', status: 'running', runId: 'run' });
        },
        abort() {
          aborts++;
          onEvent({ type: 'queue', count: 0 });
          onEvent({
            type: 'error',
            error: new Error('The operation was aborted'),
            runId: 'run',
          });
          onEvent({ type: 'status', status: 'canceled', runId: 'run' });
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input);
  await until(() => threads.get(thread.id)?.metadata?.status === 'running');
  const stopped = await service.abort('alice', thread.id);
  assert.equal(stopped.status, 'canceled');
  assert.equal(aborts, 1);
  await delay(0);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.error,
    null,
  );
});

test('failed admission leaves the input retryable without a phantom run', async (t) => {
  const { memory } = fakeMemory();
  let fail = true;
  let calls = 0;
  const service = new ThreadService(memory, {
    ...base,
    async open({ onEvent }) {
      return sessionStub({
        async send() {
          if (fail) throw new Error('Model setup failed');
          calls++;
          onEvent({ type: 'status', status: 'success', runId: 'run' });
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await assert.rejects(
    service.run('alice', thread.id, input),
    /Model setup failed/,
  );
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.status,
    'idle',
  );
  fail = false;
  await service.run('alice', thread.id, input);
  await service.run('alice', thread.id, input);
  assert.equal(calls, 1);
});
