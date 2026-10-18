import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatUsage } from '@aime/shared/threads';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';

test('conversation totals come from persisted accounting across models and reopening', async (t) => {
  const { memory } = fakeMemory();
  let context: Parameters<ChatRunner['open']>[0] | undefined;
  let consumedTokens: number | undefined = 1500;
  let unavailable = false;
  const runner: ChatRunner = {
    async validate() {},
    async createWorkspace() {
      return 'test-workspace';
    },
    async getConsumedTokens() {
      if (unavailable) throw new Error('Accounting unavailable');
      return consumedTokens;
    },
    async open(value) {
      context = value;
      return sessionStub();
    },
  };
  const service = new ThreadService(memory, runner);
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', {
    model: null,
    reasoningEffort: 'auto',
  });
  await service.run('alice', thread.id, {
    id: 'message01',
    model: null,
    reasoningEffort: 'auto',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Hello' }],
  });
  assert.ok(context);
  const step: ChatUsage = {
    model: 'provider/model',
    maxTokens: 10000,
    totalTokens: 120,
  };
  const emit = async (usage: ChatUsage) => {
    context!.onEvent({ type: 'usage', usage });
    await delay(0);
    return (await service.getThread('alice', thread.id)).usage!;
  };
  assert.equal((await emit(step)).consumedTokens, 1500);
  assert.equal(
    (await emit(step)).consumedTokens,
    1500,
    'delivery is not accumulated twice',
  );
  consumedTokens = 1670;
  const next = await emit({
    ...step,
    model: 'provider/other',
    totalTokens: 170,
  });
  assert.equal(
    next.totalTokens,
    170,
    'context still describes the latest step',
  );
  assert.equal(next.consumedTokens, 1670);

  // A fresh service must refresh totals, including usage recorded outside the actor.
  consumedTokens = 2000;
  const reopened = new ThreadService(memory, runner);
  t.after(() => reopened.shutdown());
  assert.equal(
    (await reopened.getThread('alice', thread.id)).usage?.consumedTokens,
    2000,
  );
  assert.equal(
    (await emit({ ...step, totalTokens: undefined })).consumedTokens,
    2000,
  );
  consumedTokens = 0;
  assert.equal((await emit(step)).consumedTokens, 0);
  consumedTokens = undefined;
  assert.equal((await emit(step)).consumedTokens, undefined);
  unavailable = true;
  assert.equal((await emit(step)).consumedTokens, undefined);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.error,
    null,
  );
});
