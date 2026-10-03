import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatUsage, ThreadSnapshot } from '@aime/shared/threads';
import type { UIMessage } from 'ai';
import { getChatUsage } from '../apps/server/src/modules/threads/usage.js';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';

test('step usage preserves unknown and zero counts and does not double-count reasoning or cache', () => {
  const model = { reference: 'provider/model', maxContextTokens: 128000 };
  const usage = getChatUsage(
    {
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: undefined,
      reasoningTokens: 150,
      cachedInputTokens: 800,
      cacheCreationInputTokens: 0,
    },
    model,
  );
  assert.equal(usage.totalTokens, 1200);
  assert.equal(usage.maxTokens, 128000);
  assert.equal(usage.reasoningTokens, 150);
  assert.equal(usage.cachedInputTokens, 800);
  assert.equal(usage.cacheCreationInputTokens, 0);
  assert.equal(
    getChatUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model)
      .totalTokens,
    0,
  );
  const unknown = getChatUsage(
    {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    },
    { reference: 'provider/custom' },
  );
  assert.equal(unknown.totalTokens, undefined);
  assert.equal(unknown.maxTokens, null);
});

test('usage is streamed before completion, replaces the previous step, and survives reopening', async (t) => {
  const { memory, threads } = fakeMemory();
  let context: Parameters<ChatRunner['execute']>[0] | undefined;
  let finish!: () => void;
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return 'test-workspace';
    },
    async execute(value) {
      context = value;
      value.onStatus('running');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', {
    model: null,
    reasoningEffort: 'auto',
  });
  const snapshots: ThreadSnapshot<UIMessage>[] = [];
  const unsubscribe = await service.subscribe('alice', thread.id, (snapshot) =>
    snapshots.push(snapshot),
  );
  t.after(unsubscribe);
  assert.equal(snapshots[0].usage, null);
  await service.run('alice', thread.id, {
    id: 'message01',
    model: null,
    reasoningEffort: 'auto',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Hello' }],
  });
  for (let i = 0; i < 100 && !context; i++) await delay(5);
  assert.ok(context);
  const first: ChatUsage = {
    model: 'provider/model',
    maxTokens: 10000,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
  };
  const second: ChatUsage = {
    ...first,
    model: 'provider/other',
    maxTokens: null,
    inputTokens: 150,
    totalTokens: 170,
  };
  try {
    await context.onUsage(first);
    await context.onUsage(second);
    assert.deepEqual(threads.get(thread.id)?.metadata?.usage, second);
    assert.equal(
      Object.hasOwn(threads.get(thread.id)!.metadata!, 'aime'),
      false,
    );
    await delay(0);
    assert.ok(
      snapshots.some(
        (snapshot) =>
          snapshot.thread.status === 'running' &&
          snapshot.usage?.totalTokens === 120,
      ),
    );
    assert.deepEqual(
      (await service.getThread('alice', thread.id)).usage,
      second,
    );
    // A fresh service reads persisted data even while the original run is active.
    const reopened = new ThreadService(memory, {
      async validate() {},
      async createWorkspace() {
        return 'test';
      },
      async execute() {},
    });
    t.after(() => reopened.shutdown());
    assert.deepEqual(
      (await reopened.getThread('alice', thread.id)).usage,
      second,
    );
    assert.equal(
      (await reopened.getThread('alice', thread.id)).usage?.totalTokens,
      170,
    );
  } finally {
    finish();
  }
});
