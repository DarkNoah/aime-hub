import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { RunInput } from '@aime/shared/threads';
import type { LanguageModelService } from '../models/language-model.js';
import type { ChatSessionEvent } from './session.js';
import { createChatRunner } from './runner.js';

test(
  'native sends select attachment data per model and preserve image bytes in persisted history',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp('/tmp/runner-attachments-');
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, logger: false });
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'reply' });
            controller.enqueue({
              type: 'text-delta',
              id: 'reply',
              delta: 'Done',
            });
            controller.enqueue({ type: 'text-end', id: 'reply' });
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
    const runner = createChatRunner(
      mastra,
      {
        getLanguageModel: async (_user: string, input: RunInput) => ({
          reference: input.model,
          model,
          providerOptions: {},
          modalitiesInput:
            input.model === 'mock/image' ? ['text', 'image'] : ['text'],
          supportsImages: input.model === 'mock/image',
          toolCall: false,
        }),
      } as unknown as LanguageModelService,
      root,
      undefined,
      { buildTools: async () => ({}) },
    );
    const directory = await runner.createWorkspace('alice');
    const thread = {
      id: 'attachmentthread',
      resourceId: 'user:alice',
      title: 'Attachments',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { workspace: directory },
    };
    const store = (await storage.getStore('memory'))!;
    await store.saveThread({ thread });
    const events: ChatSessionEvent[] = [];
    const session = await runner.open({
      thread,
      settings: { model: 'mock/text', reasoningEffort: 'auto' },
      onEvent: (event) => events.push(event),
    });
    t.after(async () => {
      await session.close();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const send = async (input: RunInput) => {
      const offset = events.length;
      await runner.validate('alice', input);
      await session.send(input);
      for (let i = 0; i < 500; i++) {
        const recent = events.slice(offset);
        const error = recent.find((event) => event.type === 'error');
        if (error?.type === 'error') throw error.error;
        if (
          recent.some(
            (event) => event.type === 'status' && event.status === 'success',
          )
        )
          return;
        await delay(10);
      }
      assert.fail('Run did not finish');
    };
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQmcAAAAASUVORK5CYII=';
    const base = { reasoningEffort: 'auto', isImmediate: false } as const;
    await send({
      ...base,
      id: 'message01',
      model: 'mock/text',
      parts: [
        { type: 'text', text: 'Remember this image' },
        {
          type: 'file',
          mediaType: 'image/png',
          filename: 'drawing.png',
          url: `data:image/png;base64,${png}`,
        },
      ],
    });
    await send({
      ...base,
      id: 'message02',
      model: 'mock/image',
      parts: [{ type: 'text', text: 'Now inspect it' }],
    });
    await send({
      ...base,
      id: 'message03',
      model: 'mock/text',
      parts: [{ type: 'text', text: 'Continue as text' }],
    });
    assert.equal(model.doStreamCalls.length, 3);
    for (const [index, call] of model.doStreamCalls.entries()) {
      const parts = call.prompt
        .filter((message) => message.role === 'user')
        .flatMap((message) => message.content);
      assert.equal(
        parts.filter((part) => part.type === 'file').length,
        index === 1 ? 1 : 0,
      );
      const texts = parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      assert.match(
        texts,
        /<attachment size="\d+" mimeType="image\/png" width="1" height="1">\n<\/attachment>/,
      );
      assert.doesNotMatch(texts, /<\/?attachments>/);
    }
    const history = await store.listMessages({
      threadId: thread.id,
      perPage: 100,
    });
    assert.ok(JSON.stringify(history.messages).includes(png));
    assert.doesNotMatch(JSON.stringify(history.messages), /<attachment /);
  },
);
