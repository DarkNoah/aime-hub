import { askUserTool } from '@mastra/core/tools';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { createChatRunner } from './runner.js';
import test from 'node:test';
import type { LanguageModelService } from '../models/language-model.js';
import { mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { ThreadService } from './service.js';
import { setTimeout as delay } from 'node:timers/promises';
for (const approvalAction of [undefined, 'approve', 'decline'] as const) {
  test(`native tool suspension / ${approvalAction ?? 'resume'} preserves the assistant message`, async () => {
    const previousApproval = askUserTool.requireApproval;
    askUserTool.requireApproval = approvalAction ? true : previousApproval;
    const root = await mkdtemp('/tmp/hitl-probe-');
    type StreamPart =
      Awaited<
        ReturnType<MastraLanguageModelV2Mock['doStream']>
      >['stream'] extends ReadableStream<infer T>
        ? T
        : never;
    const chunks = (parts: StreamPart[]) =>
      new ReadableStream({
        start(c) {
          for (const part of parts) c.enqueue(part);
          c.close();
        },
      });
    let count = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        count++;
        return {
          stream: chunks(
            count === 1
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: 'ask-1',
                    toolName: 'ask_user',
                    input: JSON.stringify({
                      question: 'Choose?',
                      options: [{ label: 'A' }, { label: 'B' }],
                      selectionMode: 'multi_select',
                    }),
                  },
                  {
                    type: 'finish',
                    finishReason: 'tool-calls',
                    usage: {
                      inputTokens: 10,
                      outputTokens: 10,
                      totalTokens: 20,
                    },
                  },
                ]
              : [
                  { type: 'text-start', id: 'text-1' },
                  { type: 'text-delta', id: 'text-1', delta: 'Continued' },
                  { type: 'text-end', id: 'text-1' },
                  {
                    type: 'finish',
                    finishReason: 'stop',
                    usage: {
                      inputTokens: 10,
                      outputTokens: 10,
                      totalTokens: 20,
                    },
                  },
                ],
          ),
        };
      },
    });
    const storage = new InMemoryStore();
    const memory = new Memory({ storage, options: { generateTitle: false } });
    const mastra = new Mastra({ storage, logger: false });
    const runner = createChatRunner(
      mastra,
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
    const service = new ThreadService(memory, runner);
    try {
      const settings = { model: null, reasoningEffort: 'auto' } as const;
      const thread = await service.createThread('alice', settings);
      const waitFor = async (check: () => Promise<boolean>) => {
        for (let i = 0; i < 300; i++) {
          if (await check()) return;
          await delay(10);
        }
        assert.fail(
          JSON.stringify(await service.getThread('alice', thread.id)),
        );
      };
      await service.run('alice', thread.id, {
        ...settings,
        id: 'message01',
        parts: [{ type: 'text', text: 'Ask me' }],
        isImmediate: false,
      });
      await waitFor(
        async () =>
          (await service.getThread('alice', thread.id)).thread.status ===
          'suspended',
      );
      let pending = (
        await service.getThread('alice', thread.id)
      ).toolInteractions!.find((item) => !item.response)!;
      if (approvalAction) {
        assert.equal(pending.kind, 'approval');
        await service.respondToTool('alice', thread.id, pending.id, {
          id: 'approval1',
          action: approvalAction,
        });
        if (approvalAction === 'decline') {
          await waitFor(
            async () =>
              (await service.getThread('alice', thread.id)).thread.status ===
              'success',
          );
          assert.equal(count, 2);
          return;
        }
        await waitFor(
          async () =>
            (
              await service.getThread('alice', thread.id)
            ).toolInteractions?.some(
              (item) => !item.response && item.kind === 'suspended',
            ) === true,
        );
        pending = (
          await service.getThread('alice', thread.id)
        ).toolInteractions!.find((item) => !item.response)!;
      }
      await service.respondToTool('alice', thread.id, pending.id, {
        id: 'response1',
        action: 'resume',
        data: ['A', 'B'],
      });
      await waitFor(
        async () =>
          (await service.getThread('alice', thread.id)).thread.status ===
          'success',
      );
      const messages = (
        await service.getThread('alice', thread.id)
      ).messages.filter((message) => message.role === 'assistant');
      assert.equal(messages.length, 2, JSON.stringify(messages, null, 2));
      assert.equal(
        messages
          .flatMap((message) => message.parts)
          .filter((part) => 'toolCallId' in part && part.toolCallId === 'ask-1')
          .length,
        1,
      );
      assert.ok(
        messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && part.text.includes('Continued'),
          ),
        ),
      );
      assert.ok(
        messages.some((message) =>
          message.parts.some(
            (part) =>
              'toolCallId' in part &&
              part.toolCallId === 'ask-1' &&
              'output' in part &&
              JSON.stringify(part.output).includes('User answered: A, B'),
          ),
        ),
      );
    } finally {
      await service.shutdown();
      await mastra.shutdown();
      askUserTool.requireApproval = previousApproval;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [action, repeatQuestion] of [
  ['resume', false],
  ['resume', true],
  ['decline', false],
  ['decline', true],
] as const) {
  test(`${action} a native suspended tool updates before the next model reply (suspend again=${repeatQuestion})`, async (t) => {
    const root = await mkdtemp('/tmp/hitl-service-');
    const storage = new InMemoryStore();
    const memory = new Memory({ storage, options: { generateTitle: false } });
    const mastra = new Mastra({ storage, logger: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resumed = false;
    let calls = 0;
    let continuationPrompt = '';
    const model = new MastraLanguageModelV2Mock({
      doStream: async ({ prompt }) => {
        const initial = ++calls <= (repeatQuestion ? 2 : 1);
        if (!initial) {
          continuationPrompt = JSON.stringify(prompt);
          resumed = true;
          await gate;
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              if (initial)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: `ask-service-${calls}`,
                  toolName: 'ask_user',
                  input: JSON.stringify({ question: 'Continue?' }),
                });
              else {
                controller.enqueue({ type: 'text-start', id: 'text' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'text',
                  delta: 'Resumed',
                });
                controller.enqueue({ type: 'text-end', id: 'text' });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: initial ? 'tool-calls' : 'stop',
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
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
          supportsImages: false,
          toolCall: false,
        }),
      } as unknown as LanguageModelService,
      root,
    );
    const service = new ThreadService(memory, runner);
    t.after(async () => {
      release();
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const settings = { model: null, reasoningEffort: 'auto' } as const;
    const thread = await service.createThread('alice', settings);
    const statuses: string[] = [];
    await service.subscribe('alice', thread.id, (snapshot) =>
      statuses.push(
        `${snapshot.thread.status}${snapshot.thread.error ? ': ' + snapshot.thread.error : ''}`,
      ),
    );
    await service.run('alice', thread.id, {
      ...settings,
      id: 'message01',
      parts: [{ type: 'text', text: 'Ask me' }],
      isImmediate: false,
    });
    const waitFor = async (check: () => Promise<boolean> | boolean) => {
      for (let i = 0; i < 200; i++) {
        if (await check()) return;
        await delay(5);
      }
      assert.fail(`Timed out: ${statuses.join(', ')}`);
    };
    await waitFor(
      async () =>
        !!(await service.getThread('alice', thread.id)).toolInteractions
          ?.length,
    );
    const interaction = (await service.getThread('alice', thread.id))
      .toolInteractions![0];
    statuses.length = 0;
    const accepted = await service.respondToTool(
      'alice',
      thread.id,
      interaction.id,
      action === 'decline'
        ? { id: 'response1', action }
        : { id: 'response1', action, data: 'Yes' },
    );
    assert.equal(accepted.status, 'pending');
    if (repeatQuestion) {
      await waitFor(async () => {
        const snapshot = await service.getThread('alice', thread.id);
        return (
          snapshot.thread.status === 'suspended' &&
          snapshot.toolInteractions?.some(
            (item) => item.toolCallId === 'ask-service-2',
          ) === true
        );
      });
      assert.equal(statuses.at(-1), 'suspended');
      const next = (
        await service.getThread('alice', thread.id)
      ).toolInteractions!.find((item) => item.toolCallId === 'ask-service-2')!;
      const acceptedAgain = await service.respondToTool(
        'alice',
        thread.id,
        next.id,
        action === 'decline'
          ? { id: 'response2', action }
          : { id: 'response2', action, data: 'Yes again' },
      );
      assert.equal(acceptedAgain.status, 'pending');
    }
    await waitFor(() => resumed);
    assert.equal(
      (await service.getThread('alice', thread.id)).thread.status,
      'running',
      statuses.join(', '),
    );
    assert.ok(statuses.includes('pending'));
    assert.ok(statuses.includes('running'));
    if (action === 'decline') {
      assert.match(
        continuationPrompt,
        /The user declined to answer this question\./,
      );
    }
    release();
    await waitFor(
      async () =>
        (await service.getThread('alice', thread.id)).thread.status ===
        'success',
    );
    if (action === 'decline') {
      await service.shutdown();
      const restored = new ThreadService(memory, runner);
      t.after(() => restored.shutdown());
      const snapshot = await restored.getThread('alice', thread.id);
      assert.equal(
        snapshot.toolInteractions?.find((item) => item.id === interaction.id)
          ?.response?.action,
        'decline',
      );
    }
  });
}
