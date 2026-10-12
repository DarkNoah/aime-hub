import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { z } from 'zod';
import { createChatRunner } from './runner.js';
import type { LanguageModelService } from '../models/language-model.js';

// Exercise native queued signals: the session owner must not become every asset's author.
test(
  'asset tool context follows each project message creator, including queued messages',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp('/tmp/runner-asset-creator-');
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, logger: false });
    const creators: unknown[] = [];
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MastraLanguageModelV2Mock({
      doStream: async ({ prompt }) => {
        const actor = JSON.stringify(prompt).includes('bob prompt')
          ? 'bob'
          : 'alice';
        if (!started) {
          started = true;
          await gate;
        }
        const call = !creators.includes(actor);
        return {
          stream: new ReadableStream({
            start(controller) {
              if (call)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: `asset-${actor}`,
                  toolName: 'image_gen',
                  input: '{}',
                });
              controller.enqueue({
                type: 'finish',
                finishReason: call ? 'tool-calls' : 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const runner = createChatRunner(
      mastra,
      {
        getLanguageModel: async () => ({
          model,
          reference: 'mock',
          providerOptions: {},
          supportsImages: true,
          toolCall: true,
        }),
      } as unknown as LanguageModelService,
      root,
      undefined,
      {
        buildTools: async () => ({
          image_gen: createTool({
            id: 'image_gen',
            description: 'Record a generated asset author',
            inputSchema: z.object({}),
            execute: async (_input, context) => {
              creators.push(context.requestContext.get('userId'));
              return { ok: true };
            },
          }),
        }),
      },
    );
    const settings = { model: null, reasoningEffort: 'auto' } as const;
    const thread = {
      id: 'projectthread001',
      resourceId: 'project:project000000001',
      title: 'Assets',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { createdBy: 'thread-owner' },
    };
    await (await storage.getStore('memory'))!.saveThread({ thread });
    const session = await runner.open({
      thread,
      settings,
      onEvent: () => {},
    });
    t.after(async () => {
      release();
      await session.close();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    await session.send({
      ...settings,
      id: 'message01',
      createdBy: 'alice',
      isImmediate: false,
      parts: [{ type: 'text', text: 'alice prompt' }],
    });
    for (let i = 0; !started && i < 300; i++) await delay(10);
    assert.equal(started, true);
    await session.send({
      ...settings,
      id: 'message02',
      createdBy: 'bob',
      isImmediate: false,
      parts: [{ type: 'text', text: 'bob prompt' }],
    });
    release();
    for (let i = 0; creators.length < 2 && i < 500; i++) await delay(10);
    assert.deepEqual(creators, ['alice', 'bob']);
  },
);
