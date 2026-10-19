import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { noopObserve } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { isToolUIPart, type UIMessage } from 'ai';
import {
  intelligentUiResumeSchema,
  parseIntelligentUiResponse,
} from '@aime/shared/intelligent-ui';
import { z } from 'zod';
import { intelligentUI } from '../../mastra/tools/intelligent-ui.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';
import { summarizeTurn } from './turns.js';
import { buildTools, parseToolConfig } from '../tools/registry.js';
import type { LanguageModelService } from '../models/language-model.js';
import { executeTurn } from '../../../../../scripts/fixtures/runner-turn.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const html =
  '<form data-ui-resume><input name="name"><button>Submit</button></form>';

test('IntelligentUI registers in settings, supports disable, and returns cancellation normally', async () => {
  assert.equal(parseToolConfig('IntelligentUI', {}).kind, 'builtin');
  assert.equal(
    (await buildTools(['IntelligentUI'])).IntelligentUI,
    intelligentUI,
  );
  assert.deepEqual(
    await buildTools(['IntelligentUI'], { IntelligentUI: { enabled: false } }),
    {},
  );
  assert.equal(
    await intelligentUI.execute!(
      { html, waitForResponse: true },
      { abortSignal: AbortSignal.abort(), observe: noopObserve },
    ),
    '用户中止了操作',
  );
});

for (const responseData of [
  undefined,
  {
    action: 'select',
    coordinates: { x: 12, y: 34 },
    slider: 0,
    fields: { name: '测试', agree: false },
    events: ['click', 'slide'],
  },
  { cancelled: true },
  {},
]) {
  const waitForResponse = responseData !== undefined;
  test(
    `native runtime ${waitForResponse ? 'resumes ' + JSON.stringify(responseData) : 'renders without suspension'}`,
    { timeout: 30000 },
    async (t) => {
      const root = await mkdtemp('/tmp/intelligent-ui-runtime-');
      const storage = new InMemoryStore();
      const memory = new Memory({ storage, options: { generateTitle: false } });
      const mastra = new Mastra({ storage, logger: false });
      t.after(async () => {
        await mastra.shutdown();
        await rm(root, { recursive: true, force: true });
      });
      let calls = 0;
      const model = new MastraLanguageModelV2Mock({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              if (++calls === 1)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'panel-call',
                  toolName: 'IntelligentUI',
                  input: JSON.stringify({
                    html,
                    title: 'Panel',
                    waitForResponse,
                  }),
                });
              else {
                controller.enqueue({ type: 'text-start', id: 'text' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'text',
                  delta: 'Result received.',
                });
                controller.enqueue({ type: 'text-end', id: 'text' });
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
      const workspace = await runner.createWorkspace('alice');
      const thread = await memory.createThread({
        threadId: 'panel-thread',
        resourceId: 'user:alice',
        metadata: { workspace },
      });
      const messages = new Map<string, UIMessage>();
      const context: Parameters<typeof executeTurn>[1] = {
        thread,
        input: {
          ...settings,
          id: 'message01',
          parts: [{ type: 'text', text: 'Render a panel' }],
          isImmediate: false,
        },
        signal: new AbortController().signal,
        onMessage: (message) =>
          messages.set(message.id, structuredClone(message)),
        onUsage: async () => {},
        onStatus: () => {},
      };
      const initial = await executeTurn(runner, context);
      assert.equal(initial.status, waitForResponse ? 'suspended' : 'success');
      if (waitForResponse) {
        const interaction = initial.toolInteractions[0];
        assert.equal(interaction.toolName, 'IntelligentUI');
        assert.equal(calls, 1);
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
              response: {
                id: 'response1',
                action: 'resume',
                data: parseIntelligentUiResponse(responseData),
              },
            },
          },
        });
        assert.equal(resumed.status, 'success');
      } else assert.equal(initial.toolInteractions.length, 0);
      const result = [...messages.values()]
        .flatMap((message) => message.parts)
        .filter(isToolUIPart)
        .find((part) => part.toolCallId === 'panel-call');
      assert.equal(result?.state, 'output-available');
      assert.deepEqual(result?.output, responseData ?? { rendered: true });
      assert.equal(calls, 2);
      const summary = summarizeTurn({
        id: 'turn',
        messages: [...messages.values()],
      });
      assert.deepEqual(
        summary.assistant?.parts.filter(isToolUIPart)[0]?.input,
        { html, title: 'Panel', waitForResponse },
      );
      assert.deepEqual(summary.assistant?.parts[0], result);
      assert.equal(summary.assistant?.parts.at(-1)?.type, 'text');
    },
  );
}

test(
  'persisted panel responses retain ownership, validation and duplicate protection',
  { timeout: 30000 },
  async (t) => {
    const { fakeMemory } =
      await import('../../../../../scripts/fixtures/thread-memory.js');
    const { sessionStub } =
      await import('../../../../../scripts/fixtures/thread-session.js');
    const { memory } = fakeMemory();
    let responses = 0;
    const interaction = {
      id: 'panel',
      kind: 'suspended' as const,
      toolName: 'IntelligentUI',
      runId: 'run-panel',
      toolCallId: 'panel-call',
      input: { html, waitForResponse: true },
      resumeSchema: z.toJSONSchema(intelligentUiResumeSchema),
    };
    // Use the actual service for persistence, scope and response idempotency.
    const serviceRunner: ConstructorParameters<typeof ThreadService>[1] = {
      async validate() {},
      async createWorkspace() {
        return 'workspace';
      },
      async open({ onEvent }) {
        return sessionStub({
          async send() {
            onEvent({ type: 'interaction', interaction, settings });
            onEvent({
              type: 'status',
              status: 'suspended',
              runId: 'run-panel',
            });
          },
          async respond(received, response) {
            assert.equal(received.runId, 'run-panel');
            assert.deepEqual(response.action === 'resume' && response.data, {
              field: 0,
            });
            responses++;
            onEvent({ type: 'status', status: 'success', runId: 'run-panel' });
          },
        });
      },
    };
    const first = new ThreadService(memory, serviceRunner);
    const thread = await first.createThread('alice', settings);
    await first.run('alice', thread.id, {
      ...settings,
      id: 'message01',
      isImmediate: false,
      parts: [{ type: 'text', text: 'Panel' }],
    });
    for (
      let i = 0;
      i < 100 &&
      (await first.getThread('alice', thread.id)).thread.status !== 'suspended';
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    await first.shutdown();
    const service = new ThreadService(memory, serviceRunner);
    t.after(() => service.shutdown());
    const response = {
      id: 'response1',
      action: 'resume' as const,
      data: { field: 0 },
    };
    await assert.rejects(
      service.respondToTool('bob', thread.id, interaction.id, response),
      { code: 'THREAD_NOT_FOUND' },
    );
    for (const data of [[], null, 'bad', { text: 'x'.repeat(60001) }])
      await assert.rejects(
        service.respondToTool('alice', thread.id, interaction.id, {
          ...response,
          data,
        }),
        { code: 'VALIDATION_ERROR' },
      );
    assert.equal(responses, 0);
    await Promise.all([
      service.respondToTool('alice', thread.id, interaction.id, response),
      service.respondToTool('alice', thread.id, interaction.id, response),
    ]);
    assert.equal(responses, 1);
  },
);
