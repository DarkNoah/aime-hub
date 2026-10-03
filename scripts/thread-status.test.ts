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
    let context: Parameters<ChatRunner['execute']>[0] | undefined;
    let finish!: () => void;
    const runner: ChatRunner = {
      ...base,
      async execute(value) {
        context = value;
        value.onStatus('running');
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        value.onStatus(status);
        // Status is authoritative even when there is no tool interaction payload.
        return { status, toolInteractions: [] };
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

test('stop retains the live stream status until cancellation finishes', async (t) => {
  const { memory } = fakeMemory();
  let finish!: () => void;
  let started = false;
  const service = new ThreadService(memory, {
    ...base,
    async execute({ onStatus, signal }) {
      onStatus('running');
      started = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      assert.equal(signal.aborted, true);
      onStatus('canceled');
      return { status: 'canceled', toolInteractions: [] };
    },
  });
  t.after(async () => {
    finish?.();
    await service.shutdown();
  });
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input);
  await until(() => started);
  const stopping = await service.abort('alice', thread.id);
  assert.equal(stopping.status, 'running');
  assert.equal(stopping.stopping, true);
  finish();
  await until(async () => {
    const snapshot = await service.getThread('alice', thread.id);
    return snapshot.thread.status === 'canceled' && !snapshot.thread.stopping;
  });
});

test('failures before a stream exists are persisted as failed', async (t) => {
  const { memory, threads } = fakeMemory();
  const service = new ThreadService(memory, {
    ...base,
    async execute() {
      throw new Error('Model setup failed');
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input);
  await until(
    () =>
      threads.get(thread.id)?.metadata?.status === 'failed' &&
      threads.get(thread.id)?.metadata?.activeId === null,
  );
  const snapshot = await service.getThread('alice', thread.id);
  assert.equal(snapshot.thread.status, 'failed');
  assert.equal(snapshot.thread.error, 'Model setup failed');
  assert.equal(threads.get(thread.id)?.metadata?.error, 'Model setup failed');
});

test('errors raised while stopping do not persist a failure message', async (t) => {
  const { memory, threads } = fakeMemory();
  let started = false;
  const service = new ThreadService(memory, {
    ...base,
    async execute({ onStatus, signal }) {
      onStatus('running');
      started = true;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('The operation was aborted');
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input);
  await until(() => started);
  await service.abort('alice', thread.id);
  await until(
    () =>
      threads.get(thread.id)?.metadata?.status === 'canceled' &&
      threads.get(thread.id)?.metadata?.activeId === null,
  );
  assert.equal(threads.get(thread.id)?.metadata?.error, null);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.error,
    null,
  );
});
