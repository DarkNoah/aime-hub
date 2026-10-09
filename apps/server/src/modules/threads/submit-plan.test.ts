import { executeTurn } from '../../../../../scripts/fixtures/runner-turn.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { isToolUIPart, type UIMessage } from 'ai';
import { createChatRunner } from './runner.js';
import { validateToolResponse } from './tool-interactions.js';
import type { LanguageModelService } from '../models/language-model.js';
import {
  createSubmitPlanResponse,
  getSubmitPlanData,
} from '../../../../web/src/components/chat/tool-renderers/submit-plan-data.js';

for (const [action, feedback] of [
  ['approved', undefined],
  ['rejected', undefined],
  ['rejected', 'Add a rollback step'],
] as const) {
  test(`submit_plan resumes with ${action}${feedback ? ' and feedback' : ''}`, async (t) => {
    const root = await mkdtemp('/tmp/submit-plan-');
    t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            if (++calls === 1) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'plan-call',
                toolName: 'submit_plan',
                input: JSON.stringify({ path: '.mastracode/plans/test.md' }),
              });
            } else {
              controller.enqueue({ type: 'text-start', id: 'text-1' });
              controller.enqueue({
                type: 'text-delta',
                id: 'text-1',
                delta: 'Decision received.',
              });
              controller.enqueue({ type: 'text-end', id: 'text-1' });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: calls === 1 ? 'tool-calls' : 'stop',
              usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            });
            controller.close();
          },
        }),
      }),
    });
    const storage = new InMemoryStore();
    const memory = new Memory({ storage, options: { generateTitle: false } });
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
    const workspace = await runner.createWorkspace('alice');
    const thread = await memory.createThread({
      threadId: 'plan-thread',
      resourceId: 'user:alice',
      metadata: { workspace },
    });
    const messages = new Map<string, UIMessage>();
    const context: Parameters<typeof executeTurn>[1] = {
      thread,
      input: {
        id: 'message01',
        model: null,
        reasoningEffort: 'auto',
        parts: [{ type: 'text', text: 'Submit a plan' }],
        isImmediate: false,
      },
      signal: new AbortController().signal,
      onMessage: (message) =>
        messages.set(message.id, structuredClone(message)),
      onUsage: async () => {},
      onStatus: () => {},
    };
    const initial = await executeTurn(runner, context);
    assert.equal(initial?.status, 'suspended');
    const interaction = initial?.toolInteractions[0];
    assert.ok(interaction);
    assert.equal(interaction.kind, 'suspended');
    const response = {
      id: 'response1',
      ...createSubmitPlanResponse(
        action,
        getSubmitPlanData(interaction).path,
        feedback,
      ),
    };
    validateToolResponse(interaction, response);
    const resumed = await executeTurn(runner, {
      ...context,
      input: {
        ...context.input,
        id: 'response1',
        parts: [],
        resume: {
          interactionId: interaction.id,
          kind: interaction.kind,
          runId: interaction.runId,
          toolCallId: interaction.toolCallId,
          response,
        },
      },
    });
    assert.equal(resumed?.status, 'success');
    const result = [...messages.values()]
      .flatMap((message) => message.parts)
      .filter(isToolUIPart)
      .find((part) => part.toolCallId === 'plan-call');
    assert.ok(result);
    assert.equal(result.state, 'output-available');
    const data = getSubmitPlanData(undefined, result);
    assert.equal(data.decision, action);
    assert.equal(data.feedback, feedback);
    assert.equal(data.path, '.mastracode/plans/test.md');
    assert.equal(calls, 2);
  });
}
