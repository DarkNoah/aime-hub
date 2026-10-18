import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import type { ChatSessionEvent } from './session.js';

test(
  'native retry repairs interrupted history before the model call and persists/publishes the error result',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp('/tmp/runner-incomplete-tools-');
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, logger: false });
    const model = new MastraLanguageModelV2Mock({
      doStream: async ({ prompt }) => {
        const parts = prompt.flatMap((m) =>
          typeof m.content === 'string' ? [] : m.content,
        );
        const call = parts.find(
          (p) => p.type === 'tool-call' && p.toolCallId === 'interrupted-call',
        );
        assert.ok(call);
        const result = parts.find(
          (p) =>
            p.type === 'tool-result' && p.toolCallId === 'interrupted-call',
        );
        assert.ok(result?.type === 'tool-result');
        assert.equal(result.output.type, 'error-text');
        assert.match(
          JSON.stringify(result.output),
          /interrupted or terminated/,
        );
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 'reply' });
              controller.enqueue({
                type: 'text-delta',
                id: 'reply',
                delta: 'The prior tool did not finish.',
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
        };
      },
    });
    const runner = createChatRunner(
      mastra,
      {
        getLanguageModel: async () => ({
          model,
          reference: 'mock/text',
          providerOptions: {},
          toolCall: false,
        }),
      } as unknown as LanguageModelService,
      root,
      undefined,
      { buildTools: async () => ({}) },
    );
    const thread = {
      id: 'interrupted-tools-thread',
      resourceId: 'user:alice',
      title: 'Interrupted tools',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { workspace: await runner.createWorkspace('alice') },
    };
    const store = (await storage.getStore('memory'))!;
    await store.saveThread({ thread });
    await store.saveMessages({
      messages: [
        {
          id: 'user-message',
          threadId: thread.id,
          resourceId: thread.resourceId,
          role: 'user',
          createdAt: new Date(Date.now() - 2000),
          content: {
            format: 2,
            parts: [{ type: 'text', text: 'Run the command.' }],
          },
        },
        {
          id: 'interrupted-message',
          threadId: thread.id,
          resourceId: thread.resourceId,
          role: 'assistant',
          createdAt: new Date(Date.now() - 1000),
          content: {
            format: 2,
            parts: [
              {
                type: 'reasoning',
                reasoning: '',
                details: [{ type: 'text', text: '' }],
                providerMetadata: {
                  openai: {
                    itemId: 'reasoning-1',
                    reasoningEncryptedContent: 'opaque',
                  },
                },
              },
              {
                type: 'tool-invocation',
                toolInvocation: {
                  state: 'call',
                  toolName: 'exec_command',
                  toolCallId: 'interrupted-call',
                  args: { command: 'example' },
                },
              },
            ],
          },
        },
      ],
    });
    const events: ChatSessionEvent[] = [];
    const settings = { model: 'mock/text', reasoningEffort: 'auto' } as const;
    const session = await runner.open({
      thread,
      settings,
      onEvent: (event) => events.push(event),
    });
    t.after(async () => {
      await session.close();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    await session.retry(settings);
    for (let i = 0; i < 500; i++) {
      const error = events.find((event) => event.type === 'error');
      if (error?.type === 'error') throw error.error;
      if (
        events.some(
          (event) => event.type === 'status' && event.status === 'success',
        )
      )
        break;
      await delay(10);
    }
    assert.ok(
      events.some(
        (event) => event.type === 'status' && event.status === 'success',
      ),
    );
    assert.equal(model.doStreamCalls.length, 1);
    const history = await store.listMessages({
      threadId: thread.id,
      perPage: 100,
    });
    const repaired = history.messages
      .flatMap((m) => m.content.parts)
      .find(
        (p) =>
          p.type === 'tool-invocation' &&
          p.toolInvocation.toolCallId === 'interrupted-call',
      );
    assert.equal(repaired?.type, 'tool-invocation');
    if (repaired?.type !== 'tool-invocation') return;
    assert.equal(repaired.toolInvocation.state, 'output-error');
    assert.match(
      repaired.toolInvocation.errorText ?? '',
      /interrupted or terminated/,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'message' &&
          event.message.parts.some(
            (p) =>
              'toolCallId' in p &&
              p.toolCallId === 'interrupted-call' &&
              'state' in p &&
              p.state === 'output-error',
          ),
      ),
    );
  },
);
