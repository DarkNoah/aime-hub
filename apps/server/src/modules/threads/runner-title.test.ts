import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { RunInput } from '@aime/shared/threads';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Native title generation did not settle');
}

for (const attachmentOnly of [false, true]) {
  test(
    `native genTitle uses the first message model without delaying the chat (attachment only=${attachmentOnly})`,
    { timeout: 10000 },
    async (t) => {
      const root = await mkdtemp('/tmp/runner-title-');
      const storage = new InMemoryStore();
      const mastra = new Mastra({ storage, logger: false });
      const memory = new Memory({ storage, options: { generateTitle: false } });
      let release!: () => void;
      const titleGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const model = new MastraLanguageModelV2Mock({
        doGenerate: async () => {
          await titleGate;
          return {
            content: [{ type: 'text', text: 'Generated first title' }],
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          };
        },
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 'text' });
              controller.enqueue({
                type: 'text-delta',
                id: 'text',
                delta: 'Reply complete',
              });
              controller.enqueue({ type: 'text-end', id: 'text' });
              controller.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              controller.close();
            },
          }),
        }),
      });
      const initialModel = new MastraLanguageModelV2Mock({});
      const runner = createChatRunner(
        mastra,
        {
          getLanguageModel: async (
            _user: string,
            selected: { model: string | null },
          ) => ({
            model:
              selected.model === 'mock/first-message' ? model : initialModel,
            reference: selected.model ?? 'mock',
            providerOptions: {},
            supportsImages: true,
            toolCall: false,
          }),
        } as unknown as LanguageModelService,
        root,
      );
      const service = new ThreadService(memory, runner);
      t.after(async () => {
        release();
        await service.shutdown();
        await mastra.shutdown();
        await rm(root, { recursive: true, force: true });
      });
      const settings = { model: null, reasoningEffort: 'auto' } as const;
      const thread = await service.createThread('alice', settings);
      // Opening a session before the first message must not pin the title model.
      await service.compact('alice', thread.id);
      const input: RunInput = {
        ...settings,
        model: 'mock/first-message',
        id: 'message01',
        isImmediate: false,
        parts: attachmentOnly
          ? [
              {
                type: 'file' as const,
                mediaType: 'image/png',
                url: 'data:image/png;base64,aGVsbG8=',
                filename: 'diagram.png',
              },
            ]
          : [
              {
                type: 'text' as const,
                text: 'Explain nonblocking title generation',
              },
            ],
      };
      await service.run('alice', thread.id, input);
      await until(
        async () =>
          (await service.getThread('alice', thread.id)).thread.status ===
          'success',
      );
      await until(() => model.doGenerateCalls.length === 1);
      const waiting = await service.getThread('alice', thread.id);
      assert.ok(
        waiting.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && part.text === 'Reply complete',
          ),
        ),
      );
      assert.notEqual(waiting.thread.title, 'Generated first title');
      assert.equal(initialModel.doGenerateCalls.length, 0);
      const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
      assert.ok(
        prompt.includes(
          attachmentOnly ? 'image/png' : 'Explain nonblocking title generation',
        ),
      );
      release();
      await until(
        async () =>
          (await service.getThread('alice', thread.id)).thread.title ===
          'Generated first title',
      );
      await service.run('alice', thread.id, { ...input, id: 'message02' });
      await until(
        async () =>
          (await service.getThread('alice', thread.id)).thread.status ===
          'success',
      );
      assert.equal(model.doGenerateCalls.length, 1);
      assert.equal(model.doStreamCalls.length, 2);
      assert.equal(
        (await memory.getThreadById({ threadId: thread.id }))?.title,
        'Generated first title',
      );
    },
  );
}
