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
import type { ThreadStreamStatus } from '@aime/shared/threads';
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
    try {
      const workspace = await runner.createWorkspace('alice');
      const thread = await memory.createThread({
        threadId: 'probe-thread',
        resourceId: 'user:alice',
        metadata: { workspace },
      });
      const messages = new Map<string, import('ai').UIMessage>();
      const statuses: ThreadStreamStatus[] = [];
      const context: Parameters<typeof runner.execute>[0] = {
        thread,
        input: {
          id: 'message01',
          model: null,
          reasoningEffort: 'auto',
          parts: [{ type: 'text', text: 'Ask me' }],
          isImmediate: false,
        },
        signal: new AbortController().signal,
        onMessage: (m) => messages.set(m.id, structuredClone(m)),
        onUsage: async () => {},
        onStatus: (status) => statuses.push(status),
        takeImmediate: async () => [],
      };
      let result = await runner.execute(context);
      assert.equal(result?.toolInteractions.length, 1);
      assert.ok(result);
      assert.equal(result.status, 'suspended');
      assert.equal(statuses.at(-1), 'suspended');
      assert.ok(statuses.includes('running'));
      if (approvalAction) {
        const pending = result.toolInteractions[0];
        assert.equal(pending.kind, 'approval');
        result = await runner.execute({
          ...context,
          input: {
            ...context.input,
            id: 'approval1',
            parts: [],
            resume: {
              interactionId: pending.id,
              runId: pending.runId,
              toolCallId: pending.toolCallId,
              response: { id: 'approval1', action: approvalAction },
            },
          },
        });
        assert.ok(result);
        if (approvalAction === 'decline') {
          assert.equal(result.status, 'success');
          assert.equal(statuses.at(-1), 'success');
          assert.deepEqual(result.toolInteractions, []);
          assert.equal(count, 2);
          return;
        }
        assert.equal(result.toolInteractions[0]?.kind, 'suspended');
        assert.equal(result.status, 'suspended');
      }
      const interaction = result.toolInteractions[0];
      const resumed = await runner.execute({
        ...context,
        input: {
          ...context.input,
          id: 'response1',
          parts: [],
          resume: {
            interactionId: interaction.id,
            runId: interaction.runId,
            toolCallId: interaction.toolCallId,
            response: { id: 'response1', action: 'resume', data: ['A', 'B'] },
          },
        },
      });
      assert.deepEqual(resumed, { status: 'success', toolInteractions: [] });
      assert.equal(statuses.at(-1), 'success');
      assert.equal(messages.size, 1);
      assert.ok(
        [...messages.values()].some((m) =>
          m.parts.some(
            (p) => p.type === 'text' && p.text.includes('Continued'),
          ),
        ),
      );
      assert.ok(
        [...messages.values()].some((m) =>
          m.parts.some(
            (p) =>
              'toolCallId' in p &&
              p.toolCallId === 'ask-1' &&
              'output' in p &&
              JSON.stringify(p.output).includes('User answered: A, B'),
          ),
        ),
      );
    } finally {
      askUserTool.requireApproval = previousApproval;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const repeatQuestion of [false, true]) {
  test(`answering a native suspended tool updates before the next model reply (suspend again=${repeatQuestion})`, async (t) => {
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
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        const initial = ++calls <= (repeatQuestion ? 2 : 1);
        if (!initial) {
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
      statuses.push(snapshot.thread.status),
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
      { id: 'response1', action: 'resume', data: 'Yes' },
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
        { id: 'response2', action: 'resume', data: 'Yes again' },
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
    release();
    await waitFor(
      async () =>
        (await service.getThread('alice', thread.id)).thread.status ===
        'success',
    );
  });
}
