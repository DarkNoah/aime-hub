import assert from 'node:assert/strict';
import test from 'node:test';
import type { UIMessage } from 'ai';
import { consumeSessionStream } from '../apps/server/src/modules/threads/session-stream.js';
import { summarizeTurn } from '../apps/server/src/modules/threads/turns.js';

test('a reopened ask_user run reaches success when the stream resumes without a start event', async () => {
  const runId = 'saved-run';
  const tool = { toolCallId: 'ask', toolName: 'ask_user' };
  const chunks = [
    { type: 'tool-call-suspended', payload: tool },
    { type: 'tool-call-resumed', payload: { ...tool, kind: 'suspension' } },
    { type: 'tool-result', payload: { ...tool, result: 'Daily' } },
    {
      type: 'finish',
      payload: { stepResult: { reason: 'stop' }, output: { usage: {} } },
    },
  ];
  const messages = new Map<string, UIMessage>([
    [
      'answer',
      {
        id: 'answer',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'ask',
            state: 'input-available',
            input: { question: 'Which settings?' },
          },
        ],
      },
    ],
  ]);
  const statuses: string[] = [];
  await consumeSessionStream(
    {
      activeRunId: () => runId,
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks)
            controller.enqueue({ ...chunk, runId, from: 'AGENT' });
          controller.close();
        },
      }),
    } as unknown as Parameters<typeof consumeSessionStream>[0],
    messages,
    () => ({ model: null, reasoningEffort: 'auto' }),
    (event) => {
      if (event.type === 'error') assert.fail(String(event.error));
      if (event.type === 'status') {
        assert.equal(event.runId, runId);
        statuses.push(event.status);
      }
    },
    () => {},
    async () => {},
  );
  assert.deepEqual(statuses, ['running', 'success']);
  assert.ok(
    messages
      .get('answer')
      ?.parts.some((part) => 'output' in part && part.output === 'Daily'),
  );
});

test('answered ask_user cards remain in the overview in order without adding empty details', () => {
  for (const identity of [
    { type: 'tool-ask_user' as const },
    { type: 'dynamic-tool' as const, toolName: 'ask_user' },
  ]) {
    for (const result of [
      { state: 'output-available' as const, output: 'Daily' },
      { state: 'output-available' as const, output: ['Daily', 'Points'] },
      {
        state: 'output-denied' as const,
        approval: { id: 'declined', approved: false as const },
      },
    ]) {
      const ask = {
        ...identity,
        toolCallId: 'ask',
        input: { question: 'Which settings?' },
        ...result,
      };
      const final = {
        type: 'text' as const,
        text: 'Continuing.',
        state: 'done' as const,
      };
      const messages: UIMessage[] = [
        { id: 'answer', role: 'assistant', parts: [ask] },
        { id: 'final', role: 'assistant', parts: [final] },
      ];
      const summary = summarizeTurn({ id: 'turn', messages });
      assert.deepEqual(summary.assistant?.parts, [
        { ...ask, forceRender: true },
        final,
      ]);
      assert.equal(summary.hasDetails, false);
      assert.equal(summary.toolCount, 1);
      assert.deepEqual(
        summarizeTurn({ id: 'ask-only', messages: [messages[0]] }).assistant
          ?.parts,
        [{ ...ask, forceRender: true }],
        'an answered question is visible even before the next assistant text',
      );
    }
    const pending: UIMessage = {
      id: 'pending',
      role: 'assistant',
      parts: [
        {
          ...identity,
          toolCallId: 'ask',
          state: 'input-available',
          input: { question: 'Which settings?' },
        },
      ],
    };
    assert.deepEqual(
      summarizeTurn({ id: 'turn', messages: [pending] }).assistant?.parts,
      [{ ...pending.parts[0], forceRender: true }],
      'pending forced tools remain in the overview; the UI deduplicates actionable cards',
    );
  }
});
