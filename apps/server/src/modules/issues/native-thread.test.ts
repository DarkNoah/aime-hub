import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { ThreadService } from '../threads/service.js';
import { createChatRunner } from '../threads/runner.js';
import type { LanguageModelService } from '../models/language-model.js';
import type { ThreadStatus } from '@aime/shared/threads';

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Issue thread did not settle');
}

test('native issue thread stops active and queued work, preserves binding and can continue', async (t) => {
  const directory = await mkdtemp('/tmp/issue-native-');
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const mastra = new Mastra({
    storage,
    logger: false,
    backgroundTasks: { enabled: true },
  });
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new MastraLanguageModelV2Mock({
    doStream: async ({ prompt, abortSignal }) => {
      prompts.push(JSON.stringify(prompt));
      if (prompts.length === 1)
        await Promise.race([
          gate,
          new Promise<void>((resolve) => {
            if (abortSignal?.aborted) resolve();
            else
              abortSignal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
          }),
        ]);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'answer' });
            controller.enqueue({
              type: 'text-delta',
              id: 'answer',
              delta: 'Task result',
            });
            controller.enqueue({ type: 'text-end', id: 'answer' });
            controller.enqueue({
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  const runner = createChatRunner(
    mastra,
    {
      getLanguageModel: async () => ({
        model,
        reference: 'fixture',
        providerOptions: {},
        supportsImages: true,
        toolCall: false,
      }),
    } as unknown as LanguageModelService,
    directory,
  );
  const threads = new ThreadService(
    memory,
    runner,
    undefined,
    mastra.backgroundTaskManager,
  );
  t.after(async () => {
    release();
    await threads.shutdown();
    await mastra.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const observed: ThreadStatus[] = [];
  threads.setIssueObserver(async (id, status) => {
    assert.equal(id, 123);
    observed.push(status);
  });
  const settings = { model: null, reasoningEffort: 'auto' } as const;
  const thread = await threads.createIssueThread(
    'alice',
    { ...settings, title: '#123 Task' },
    123,
  );
  const input = (id: string) => ({
    ...settings,
    id,
    parts: [{ type: 'text' as const, text: id }],
    isImmediate: false,
  });
  await threads.run('alice', thread.id, input('issueinput01'));
  await until(async () => prompts.length === 1);
  assert.match(prompts[0]!, /Issue #123/);
  await threads.run('alice', thread.id, input('issueinput02'));
  await until(
    async () =>
      (await threads.getThread('alice', thread.id)).thread.queueCount === 1,
  );
  await threads.stopIssueThread('alice', thread.id);
  release();
  await until(async () => {
    const current = await threads.getThread('alice', thread.id);
    return (
      current.thread.status === 'canceled' && current.thread.queueCount === 0
    );
  });
  assert.equal(prompts.length, 1, 'stopped queue must not execute');
  await threads.run('alice', thread.id, input('issueinput03'));
  await until(
    async () =>
      (await threads.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[1]!, /issueinput02/);
  assert.equal(
    (await memory.getThreadById({ threadId: thread.id }))?.metadata?.issueId,
    123,
  );
  assert.ok(observed.includes('running'));
  assert.ok(observed.includes('canceled'));
  assert.ok(observed.includes('success'));
});
