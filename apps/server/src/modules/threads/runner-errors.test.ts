import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = {
  ...settings,
  id: 'message01',
  isImmediate: false,
  parts: [{ type: 'text' as const, text: 'Hello' }],
};

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('Thread did not finish persisting its run');
}

for (const scenario of [
  { name: 'error chunk', error: new Error('Provider stream disconnected') },
  { name: 'string error chunk', error: 'Provider quota exceeded' },
  {
    name: 'serialized error chunk',
    error: { message: 'Provider unavailable', requestBodyValues: 'private' },
  },
  { name: 'unknown error chunk', error: { unexpected: true } },
  { name: 'stream rejection', error: new Error('Stream transport failed') },
  { name: 'model rejection', error: new Error('Model request failed') },
]) {
  test(`${scenario.name} persists the error message across thread reopening`, async (t) => {
    const root = await mkdtemp('/tmp/runner-errors-');
    const storage = new InMemoryStore();
    const memory = new Memory({ storage, options: { generateTitle: false } });
    let recovered = false;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        if (!recovered && scenario.name === 'model rejection')
          throw scenario.error;
        return {
          stream: new ReadableStream({
            start(controller) {
              if (!recovered && scenario.name === 'stream rejection') {
                controller.error(scenario.error);
                return;
              }
              controller.enqueue({ type: 'text-start', id: 'text' });
              controller.enqueue({
                type: 'text-delta',
                id: 'text',
                delta: recovered ? 'Recovered' : 'Partial reply',
              });
              controller.enqueue({ type: 'text-end', id: 'text' });
              if (!recovered)
                controller.enqueue({ type: 'error', error: scenario.error });
              controller.enqueue({
                type: 'finish',
                finishReason: recovered ? 'stop' : 'error',
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const runner = createChatRunner(
      new Mastra({ storage, logger: false }),
      {
        getLanguageModel: async () => ({
          model,
          reference: 'mock',
          providerOptions: {},
          supportsImages: false,
          toolCall: false,
        }),
      } as unknown as LanguageModelService,
      root,
    );
    let service = new ThreadService(memory, runner);
    t.after(async () => {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const thread = await service.createThread('alice', settings);
    const errors: (string | null)[] = [];
    await service.subscribe('alice', thread.id, (snapshot) =>
      errors.push(snapshot.thread.error),
    );
    await service.run('alice', thread.id, input);
    await until(async () => {
      const stored = await memory.getThreadById({ threadId: thread.id });
      return stored?.metadata?.activeId === null && !!stored.metadata.error;
    });
    const expected =
      typeof scenario.error === 'string'
        ? scenario.error
        : 'message' in scenario.error
          ? scenario.error.message
          : 'CHAT_FAILED';
    const stored = await memory.getThreadById({ threadId: thread.id });
    assert.equal(stored?.metadata?.error, expected);
    assert.equal(stored?.metadata?.status, 'failed');
    assert.equal(stored?.metadata?.paused, true);
    assert.equal(errors.at(-1), expected);
    await service.shutdown();
    service = new ThreadService(memory, runner);
    const reopened = await service.getThread('alice', thread.id);
    assert.equal(reopened.thread.error, expected);
    assert.equal(reopened.thread.status, 'failed');
    if (scenario.name.includes('chunk'))
      assert.ok(
        reopened.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && part.text === 'Partial reply',
          ),
        ),
      );

    if (scenario.name === 'error chunk') {
      recovered = true;
      const accepted = await service.retry('alice', thread.id);
      assert.equal(accepted.error, null);
      await until(async () => {
        const latest = await memory.getThreadById({ threadId: thread.id });
        return (
          latest?.metadata?.activeId === null &&
          latest.metadata.status === 'success'
        );
      });
      assert.equal(
        (await memory.getThreadById({ threadId: thread.id }))?.metadata?.error,
        null,
      );
      const history = await service.getThread('alice', thread.id);
      assert.equal(
        history.messages.filter((item) => item.role === 'user').length,
        1,
      );
      assert.ok(
        history.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && part.text === 'Recovered',
          ),
        ),
      );
    }
  });
}
