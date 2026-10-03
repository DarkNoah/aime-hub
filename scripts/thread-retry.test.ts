import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = {
  ...settings,
  id: 'message01',
  parts: [{ type: 'text' as const, text: 'Hello' }],
  isImmediate: false,
};
const base = {
  async validate() {},
  async createWorkspace() {
    return 'workspace';
  },
};
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('Thread did not settle');
}

test('retry reopens the failed input before queued messages and ignores duplicate clicks', async (t) => {
  const { memory, threads, messages } = fakeMemory();
  const runs: Parameters<ChatRunner['execute']>[0]['input'][] = [];
  let fail!: () => void;
  let finish!: () => void;
  const runner: ChatRunner = {
    ...base,
    async execute({ input, onStatus }) {
      runs.push(input);
      onStatus('running');
      if (runs.length === 1) {
        await new Promise<void>((resolve) => {
          fail = resolve;
        });
        throw new Error('Connection reset');
      }
      if (runs.length === 2)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    },
  };
  let service = new ThreadService(memory, runner);
  t.after(async () => {
    fail?.();
    finish?.();
    await service.shutdown();
  });
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input);
  await until(() => runs.length === 1);
  await service.run('alice', thread.id, { ...input, id: 'message02' });
  fail();
  await until(() => threads.get(thread.id)?.metadata?.activeId === null);
  assert.equal(threads.get(thread.id)?.metadata?.error, 'Connection reset');
  await service.shutdown();
  service = new ThreadService(memory, runner);
  await assert.rejects(service.retry('bob', thread.id), {
    message: 'THREAD_NOT_FOUND',
  });
  await Promise.all([
    service.retry('alice', thread.id),
    service.retry('alice', thread.id),
  ]);
  await until(() => runs.length === 2);
  assert.deepEqual(runs[1], runs[0]);
  assert.equal(messages.size, 1);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.queue[0].id,
    'message02',
  );
  finish();
  await until(
    () =>
      runs.length === 3 && threads.get(thread.id)?.metadata?.activeId === null,
  );
  assert.deepEqual(
    runs.map((run) => run.id),
    ['message01', 'message01', 'message02'],
  );
  assert.equal(messages.size, 2);
  assert.equal(threads.get(thread.id)?.metadata?.error, null);
  assert.equal(threads.get(thread.id)?.metadata?.failedInput, null);
});

test('a failed retry admission preserves the error and can be retried again', async (t) => {
  const { memory, threads } = fakeMemory();
  let runs = 0;
  const service = new ThreadService(memory, {
    ...base,
    async execute() {
      if (++runs === 1) throw new Error('Provider unavailable');
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input);
  await until(() => threads.get(thread.id)?.metadata?.activeId === null);
  const update = memory.updateThread;
  memory.updateThread = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(service.retry('alice', thread.id), {
    message: 'Storage unavailable',
  });
  assert.equal(runs, 1);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.error,
    'Provider unavailable',
  );
  memory.updateThread = update;
  await service.retry('alice', thread.id);
  await until(
    () => runs === 2 && threads.get(thread.id)?.metadata?.activeId === null,
  );
  assert.equal(threads.get(thread.id)?.metadata?.error, null);
});

test('legacy failed threads retry their stored user message without duplicating it', async (t) => {
  const { memory, threads, messages } = fakeMemory();
  let runs = 0;
  const runner: ChatRunner = {
    ...base,
    async execute({ input: retried }) {
      if (++runs === 1) throw new Error('Provider unavailable');
      assert.equal(retried.id, input.id);
      assert.deepEqual(retried.parts, input.parts);
    },
  };
  let service = new ThreadService(memory, runner);
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input);
  await until(() => threads.get(thread.id)?.metadata?.activeId === null);
  await service.shutdown();
  delete threads.get(thread.id)!.metadata!.failedInput;
  service = new ThreadService(memory, runner);
  await service.retry('alice', thread.id);
  await until(
    () => runs === 2 && threads.get(thread.id)?.metadata?.activeId === null,
  );
  assert.equal(messages.size, 1);
  assert.equal(threads.get(thread.id)?.metadata?.error, null);
});

test('retry preserves a failed tool response and resumes its pending interaction', async (t) => {
  const { memory, threads } = fakeMemory();
  const runs: Parameters<ChatRunner['execute']>[0]['input'][] = [];
  const service = new ThreadService(memory, {
    ...base,
    async execute({ input }) {
      runs.push(input);
      if (runs.length === 1)
        return {
          status: 'suspended',
          toolInteractions: [
            {
              id: 'interaction1',
              kind: 'suspended',
              runId: 'run1',
              toolCallId: 'call1',
              toolName: 'ask_user',
              suspendPayload: { question: 'Continue?' },
            },
          ],
        };
      if (runs.length === 2) throw new Error('Resume failed');
      return { status: 'success', toolInteractions: [] };
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input);
  await until(() => threads.get(thread.id)?.metadata?.activeId === null);
  await service.respondToTool('alice', thread.id, 'interaction1', {
    id: 'response01',
    action: 'resume',
    data: 'Yes',
  });
  await until(
    () => threads.get(thread.id)?.metadata?.error === 'Resume failed',
  );
  await service.retry('alice', thread.id);
  await until(
    () =>
      runs.length === 3 && threads.get(thread.id)?.metadata?.activeId === null,
  );
  assert.deepEqual(runs[2], runs[1]);
  assert.equal(
    (await service.getThread('alice', thread.id)).toolInteractions?.[0].response
      ?.action,
    'resume',
  );
  assert.equal(threads.get(thread.id)?.metadata?.status, 'success');
});
