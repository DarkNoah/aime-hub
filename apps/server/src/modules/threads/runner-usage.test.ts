import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { UsageRecord } from '@aime/db';
import type { ChatSettings, RunInput } from '@aime/shared/threads';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';

async function until(check: () => boolean) {
  for (let index = 0; index < 500; index++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('runtime usage did not settle');
}

test(
  'runtime records each tool-loop step with the actual model and queued project message author',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp('/tmp/runner-usage-');
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, logger: false });
    const memory = new Memory({ storage, options: { generateTitle: false } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const rows: UsageRecord[] = [];
    const errors: unknown[] = [];
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        const call = ++calls;
        if (call === 1) await gate;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'response-metadata',
                id: `provider-response-${call}`,
                modelId: `actual-model-${call}`,
                timestamp: new Date(),
              });
              if (call === 1)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'clock',
                  toolName: 'curr_time',
                  input: '{}',
                });
              else {
                controller.enqueue({ type: 'text-start', id: 'text' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'text',
                  delta: 'Done',
                });
                controller.enqueue({ type: 'text-end', id: 'text' });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: call === 1 ? 'tool-calls' : 'stop',
                usage: {
                  inputTokens: call * 10,
                  outputTokens: call,
                  totalTokens: call * 11,
                  cachedInputTokens: call * 5,
                  reasoningTokens: call,
                },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const settings: ChatSettings = {
      model: 'provider-one/configured-one',
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
        }),
      } as unknown as LanguageModelService,
      root,
      undefined,
      undefined,
      undefined,
      {
        record: async (row) => {
          rows.push(row);
        },
      },
    );
    const projectId = 'project123456789';
    await runner.createWorkspace('alice', projectId);
    const thread = await memory.createThread({
      resourceId: `project:${projectId}`,
      title: 'Usage test',
      metadata: { createdBy: 'alice' },
    });
    const session = await runner.open({
      thread,
      settings,
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.error);
      },
    });
    t.after(async () => {
      release();
      await session.close();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const input = (
      id: string,
      createdBy: string,
      model = settings.model,
    ): RunInput => ({
      ...settings,
      model,
      id,
      createdBy,
      isImmediate: false,
      parts: [{ type: 'text', text: id }],
    });
    await session.send(input('message01', 'alice'));
    await until(() => calls === 1);
    await session.send(
      input('message02', 'bob', 'provider-two/configured-two'),
    );
    release();
    await until(() => rows.length >= 3 || errors.length > 0);
    assert.deepEqual(errors, []);
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.id)).size, 3);
    assert.deepEqual(
      rows.map((row) => row.totalTokens),
      [11, 22, 33],
      'each step, not cumulative turn totals',
    );
    assert.equal(rows[0].userId, 'alice');
    assert.equal(rows.at(-1)!.userId, 'bob');
    assert.equal(rows[0].providerId, 'provider-one');
    assert.equal(rows.at(-1)!.providerId, 'provider-two');
    assert.deepEqual(
      rows.map((row) => row.model),
      ['actual-model-1', 'actual-model-2', 'actual-model-3'],
    );
    assert.ok(
      rows.every(
        (row) =>
          row.projectId === projectId &&
          row.threadId === thread.id &&
          row.durationMs >= 0,
      ),
    );
    assert.equal(rows.at(-1)!.modelReference, 'provider-two/configured-two');
  },
);
