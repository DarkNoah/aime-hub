import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from '../threads/runner.js';
import { ThreadService } from '../threads/service.js';
import type { GroupChatService } from './service.js';

const settings = {
  agentId: 'code:assistant',
  model: 'mock/room',
  reasoningEffort: 'auto',
} as const;
const member = {
  id: 'retry-member',
  roomId: 'retry-room',
  threadId: 'retry-thread',
  role: 'bot' as const,
  enabled: true,
  settings,
};

function reply(error?: unknown) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 'text' });
        controller.enqueue({
          type: 'text-delta',
          id: 'text',
          delta: error ? 'Interrupted output' : 'Recovered',
        });
        controller.enqueue({ type: 'text-end', id: 'text' });
        if (error) controller.enqueue({ type: 'error', error });
        controller.enqueue({
          type: 'finish',
          finishReason: error ? 'error' : 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        controller.close();
      },
    }),
  };
}

async function fixture(
  t: TestContext,
  model: MastraLanguageModelV2Mock,
  role: 'bot' | 'worker' = 'bot',
) {
  const root = await mkdtemp('/tmp/group-chat-retry-');
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const mastra = new Mastra({ storage, logger: false });
  const publications: unknown[] = [];
  const rooms = {
    get: async () => ({ agents: [{ ...member, role }] }),
    getAgent: async () => ({ ...member, role }),
    sendAgent: async (...args: unknown[]) => {
      publications.push(args);
      return { id: 'published-once' };
    },
  } as unknown as GroupChatService;
  const runner = createChatRunner(
    mastra,
    {
      getLanguageModel: async () => ({
        model,
        reference: 'mock/room',
        providerOptions: {},
        supportsImages: false,
        toolCall: true,
      }),
    } as unknown as LanguageModelService,
    root,
    undefined,
    { buildTools: async () => ({}) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    rooms,
  );
  const threads = new ThreadService(memory, runner);
  const statuses: string[] = [];
  threads.setGroupChatObserver(async (_binding, status) => {
    statuses.push(status);
  });
  t.after(async () => {
    await threads.shutdown();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await threads.ensureGroupChatThread({
    ...member,
    role,
    memberId: member.id,
    userId: 'alice',
    title: 'Retry bot',
  });
  const run = () =>
    threads.runGroupChat('alice', member.threadId, {
      ...settings,
      id: 'retry-event',
      isImmediate: true,
      parts: [{ type: 'text', text: 'Publish once, then finish.' }],
    });
  const snapshot = () => threads.getThread('alice', member.threadId);
  return { threads, publications, statuses, run, snapshot };
}

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Room retry did not reach the expected state');
}

for (const role of ['bot', 'worker'] as const) {
  test(
    `${role} recovers a stream error after a publication without replaying the tool or input`,
    { timeout: 20_000 },
    async (t) => {
      let calls = 0;
      const model = new MastraLanguageModelV2Mock({
        doStream: async ({ prompt }) => {
          calls++;
          if (calls === 1)
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: 'publish-call',
                    toolName: 'send_message',
                    input: JSON.stringify({ text: 'Published exactly once' }),
                  });
                  controller.enqueue({
                    type: 'finish',
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  });
                  controller.close();
                },
              }),
            };
          assert.match(JSON.stringify(prompt), /published-once/);
          if (calls === 2)
            return reply({
              type: 'response.failed',
              response: {
                error: { code: 'server_error', message: 'Transient' },
              },
            });
          return reply();
        },
      });
      const state = await fixture(t, model, role);
      await state.run();
      await until(
        async () => (await state.snapshot()).thread.status === 'success',
      );
      assert.equal(calls, 3);
      assert.equal(state.publications.length, 1);
      assert.ok(!state.statuses.includes('failed'));
      const snapshot = await state.snapshot();
      assert.equal(snapshot.thread.error, null);
      assert.equal(
        snapshot.messages.filter((message) => message.role === 'user').length,
        1,
      );
      assert.ok(
        snapshot.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && part.text === 'Recovered',
          ),
        ),
      );
    },
  );
}

test(
  'room recovers a nested transport failure',
  { timeout: 20_000 },
  async (t) => {
    let calls = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        if (++calls === 1)
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('Socket closed'), {
              code: 'UND_ERR_SOCKET',
            }),
          });
        return reply();
      },
    });
    const state = await fixture(t, model);
    await state.run();
    await until(
      async () => (await state.snapshot()).thread.status === 'success',
    );
    assert.equal(calls, 2);
    assert.ok(!state.statuses.includes('failed'));
  },
);

test(
  'room exhausts exactly three retries with backoff and persists failure',
  { timeout: 20_000 },
  async (t) => {
    const attempts: number[] = [];
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        attempts.push(Date.now());
        throw Object.assign(new Error('Provider temporarily unavailable'), {
          statusCode: 503,
          isRetryable: true,
        });
      },
    });
    const state = await fixture(t, model);
    await state.run();
    await until(
      async () => (await state.snapshot()).thread.status === 'failed',
    );
    assert.equal(
      attempts.length,
      4,
      'request retries must not multiply processor retries',
    );
    for (let i = 1; i < attempts.length; i++)
      assert.ok(attempts[i] - attempts[i - 1] >= 1_000 * 2 ** (i - 1) - 50);
    assert.match(
      (await state.snapshot()).thread.error ?? '',
      /Provider temporarily unavailable/,
    );
  },
);

for (const statusCode of [400, 401, 403, 404, undefined]) {
  test(
    `room does not retry ${statusCode ?? 'unknown'} errors`,
    { timeout: 10_000 },
    async (t) => {
      let calls = 0;
      const model = new MastraLanguageModelV2Mock({
        doStream: async () => {
          calls++;
          throw Object.assign(new Error('Permanent failure'), { statusCode });
        },
      });
      const state = await fixture(t, model);
      await state.run();
      await until(
        async () => (await state.snapshot()).thread.status === 'failed',
      );
      assert.equal(calls, 1);
    },
  );
}

test(
  'disposing a room interrupts Retry-After backoff without another provider call',
  { timeout: 10_000 },
  async (t) => {
    let calls = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        calls++;
        throw Object.assign(new Error('Rate limited'), {
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { 'Retry-After': '30' },
        });
      },
    });
    const state = await fixture(t, model);
    await state.run();
    await until(() => calls === 1);
    await delay(100);
    assert.equal((await state.snapshot()).thread.status, 'running');
    const startedAt = Date.now();
    await state.threads.disposeGroupChatThread(member.roomId, member.threadId);
    assert.ok(
      Date.now() - startedAt < 2_000,
      'abort must not wait for Retry-After',
    );
    assert.equal(calls, 1);
  },
);
