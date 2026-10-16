import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { ChatSettings, ChatUsage } from '@aime/shared/threads';
import type { LanguageModelService } from '../models/language-model.js';
import { ContextBudget } from './context-compaction.js';
import { createChatRunner } from './runner.js';

const usage = (totalTokens?: number): ChatUsage => ({
  model: 'provider/model',
  maxTokens: 1000,
  totalTokens,
});

test('context budget preserves valid usage across failures/reopens and consumes it durably', async () => {
  const storage = new InMemoryStore();
  const store = await storage.getStore('threadState');
  const budget = await ContextBudget.load(store, 'thread', usage(799));
  budget.setLimit(1000);
  assert.equal(budget.shouldCompact, false);
  await budget.record(usage(800));
  assert.equal(budget.shouldCompact, true);
  await budget.record(usage());
  await budget.record(usage(NaN));
  const reopened = await ContextBudget.load(store, 'thread', usage());
  reopened.setLimit(1000);
  assert.equal(reopened.shouldCompact, true);
  reopened.setLimit(2000);
  assert.equal(
    reopened.shouldCompact,
    false,
    'new larger model capacity applies',
  );
  reopened.setLimit(500);
  assert.equal(
    reopened.shouldCompact,
    true,
    'new smaller model capacity applies',
  );
  for (const limit of [undefined, 0, NaN, Infinity]) {
    reopened.setLimit(limit);
    assert.equal(reopened.shouldCompact, false);
  }
  await reopened.consume();
  const consumed = await ContextBudget.load(
    store,
    'thread',
    usage(900),
    async () => {
      assert.fail('consumed usage must not be recovered from history');
    },
  );
  consumed.setLimit(1000);
  assert.equal(
    consumed.shouldCompact,
    false,
    'old metadata must not revive consumed usage',
  );
  const legacy = await ContextBudget.load(
    store,
    'legacy',
    usage(),
    async () => ({ totalTokens: 800 }),
  );
  legacy.setLimit(1000);
  assert.equal(
    legacy.shouldCompact,
    true,
    'legacy failed runs recover their last valid usage',
  );
  await consumed.record(usage(900));
  assert.equal(
    consumed.shouldCompact,
    true,
    'a fresh high usage measurement can trigger again',
  );
});

async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('context compaction did not settle');
}

for (const scenario of [
  'tool-loop',
  'model-change',
  'below-limit',
  'observer-failure',
  'reopen',
  'legacy-usage',
  '30k',
] as const) {
  test(
    `runner context compaction: ${scenario}`,
    { timeout: 25000 },
    async (t) => {
      const root = await mkdtemp('/tmp/context-compaction-');
      const storage = new InMemoryStore();
      const mastra = new Mastra({ storage, logger: false });
      const memory = new Memory({ storage, options: { generateTitle: false } });
      const order: string[] = [];
      const prompts: string[] = [];
      const errors: unknown[] = [];
      const eventTypes: string[] = [];
      const authors: string[] = [];
      const modelReferences: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let actors = 0;
      let finished = 0;
      const model = new MastraLanguageModelV2Mock({
        doStream: async ({ prompt }) => {
          const serialized = JSON.stringify(prompt);
          const observer = serialized.includes(
            'You are the memory consciousness',
          );
          if (observer) {
            order.push('observer');
            if (scenario === 'observer-failure')
              throw new Error('Observer unavailable');
          } else {
            prompts.push(serialized);
            order.push(`actor-${++actors}`);
            if (scenario === 'model-change' && actors === 1) await gate;
          }
          const tool = !observer && actors <= 2;
          const totalTokens = observer
            ? 50
            : actors === 1
              ? scenario === 'below-limit'
                ? 799
                : 800
              : 100;
          return {
            stream: new ReadableStream({
              start(controller) {
                if (tool)
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: `clock-${actors}`,
                    toolName: 'curr_time',
                    input: '{}',
                  });
                else {
                  controller.enqueue({ type: 'text-start', id: 'text' });
                  controller.enqueue({
                    type: 'text-delta',
                    id: 'text',
                    delta: observer
                      ? '<observations>\nDate: Oct 16, 2026\n- User requested the time. SUMMARY_AFTER_COMPACTION.\n</observations>'
                      : 'Done',
                  });
                  controller.enqueue({ type: 'text-end', id: 'text' });
                }
                controller.enqueue({
                  type: 'finish',
                  finishReason: tool ? 'tool-calls' : 'stop',
                  usage: {
                    inputTokens: totalTokens - 1,
                    outputTokens: 1,
                    totalTokens,
                  },
                });
                controller.close();
              },
            }),
          };
        },
      });
      const settings: ChatSettings = {
        model: 'provider/model',
        reasoningEffort: 'auto',
      };
      const runner = createChatRunner(
        mastra,
        {
          getLanguageModel: async (_user: string, selected: ChatSettings) => ({
            model,
            reference: selected.model,
            providerOptions: {},
            supportsImages: false,
            toolCall: true,
            maxContextTokens:
              scenario === '30k'
                ? undefined
                : scenario === 'model-change' &&
                    selected.model === settings.model
                  ? 2000
                  : 1000,
          }),
        } as unknown as LanguageModelService,
        root,
        undefined,
        undefined,
        undefined,
        {
          record: async (row) => {
            authors.push(row.userId);
            modelReferences.push(row.modelReference);
          },
          ...(scenario === 'legacy-usage'
            ? { latestThreadUsage: async () => ({ totalTokens: 800 }) }
            : {}),
        },
      );
      const workspace = await runner.createWorkspace('alice');
      const thread = await memory.createThread({
        resourceId: 'user:alice',
        title: 'Context budget',
        metadata: {
          createdBy: 'alice',
          workspace,
          ...(scenario === 'reopen' ? { usage: usage(800) } : {}),
        },
      });
      if (
        scenario === 'reopen' ||
        scenario === 'legacy-usage' ||
        scenario === '30k'
      )
        await memory.saveMessages({
          messages: [
            {
              id: 'old-message',
              threadId: thread.id,
              resourceId: thread.resourceId,
              role: 'user',
              createdAt: new Date('2026-10-01'),
              content: {
                format: 2,
                parts: [
                  {
                    type: 'text',
                    text:
                      scenario === '30k'
                        ? 'OLD_CONTEXT '.repeat(18000)
                        : 'OLD_CONTEXT to be compressed.',
                  },
                ],
              },
            },
          ],
        });
      const session = await runner.open({
        thread,
        settings,
        onEvent: (event) => {
          eventTypes.push(event.type);
          if (event.type === 'error') errors.push(event.error);
          if (event.type === 'usage') finished++;
        },
      });
      t.after(async () => {
        release();
        await session.close();
        await mastra.shutdown();
        await rm(root, { recursive: true, force: true });
      });
      await session.send({
        ...settings,
        id: 'input01',
        createdBy: 'alice',
        isImmediate: false,
        parts: [
          { type: 'text', text: 'Get the time twice. ORIGINAL_USER_REQUEST.' },
        ],
      });
      if (scenario === 'model-change') {
        await until(() => actors === 1);
        await session.send({
          ...settings,
          model: 'provider/second',
          id: 'input02',
          createdBy: 'bob',
          isImmediate: true,
          parts: [{ type: 'text', text: 'Continue with the second model.' }],
        });
        release();
      }
      try {
        await until(() => finished >= 3 || errors.length > 0);
      } catch (error) {
        assert.fail(
          `${String(error)}; ${JSON.stringify({ order, finished, eventTypes })}`,
        );
      }
      if (scenario === 'observer-failure') {
        assert.ok(errors.length);
        assert.equal(
          actors,
          1,
          'must stop before the next actor request when compression fails',
        );
        const budget = await ContextBudget.load(
          await storage.getStore('threadState'),
          thread.id,
          null,
        );
        budget.setLimit(1000);
        assert.equal(
          budget.shouldCompact,
          true,
          'failed observation must remain retryable',
        );
      } else {
        assert.deepEqual(errors, []);
        if (scenario === 'below-limit')
          assert.deepEqual(order, ['actor-1', 'actor-2', 'actor-3']);
        else if (scenario === 'tool-loop' || scenario === 'model-change') {
          assert.deepEqual(order, [
            'actor-1',
            'observer',
            'actor-2',
            'actor-3',
          ]);
          assert.match(prompts[1], /SUMMARY_AFTER_COMPACTION/);
          assert.doesNotMatch(prompts[1], /ORIGINAL_USER_REQUEST/);
          assert.match(
            prompts[2],
            /clock-2/,
            'tool results after compaction remain in the live context',
          );
          assert.doesNotMatch(
            prompts[2],
            /clock-1/,
            'observed tool results do not return',
          );
          if (scenario === 'model-change') {
            assert.deepEqual(modelReferences, [
              'provider/model',
              'provider/second',
              'provider/second',
            ]);
            assert.deepEqual(authors, ['alice', 'bob', 'bob']);
            assert.match(prompts[2], /model named second/);
          }
        } else {
          assert.equal(
            order[0],
            'observer',
            'compress history before the first request',
          );
          assert.match(prompts[0], /SUMMARY_AFTER_COMPACTION/);
          assert.doesNotMatch(prompts[0], /OLD_CONTEXT/);
        }
      }
      const store = await storage.getStore('memory');
      const record = await store!.getObservationalMemory(
        thread.id,
        thread.resourceId,
      );
      assert.notEqual(
        (
          record?.config?._overrides as
            { observation?: { messageTokens?: number } } | undefined
        )?.observation?.messageTokens,
        1,
      );
      assert.equal(
        (record?.config?.observation as { messageTokens?: number } | undefined)
          ?.messageTokens,
        30000,
        'the configured 30k threshold is unchanged',
      );
    },
  );
}
