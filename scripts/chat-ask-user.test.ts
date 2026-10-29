import assert from 'node:assert/strict';
import test from 'node:test';
import type { UIMessage } from 'ai';
import { summarizeTurn } from '../apps/server/src/modules/threads/turns.js';

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
      assert.deepEqual(summary.assistant?.parts, [ask, final]);
      assert.equal(summary.hasDetails, false);
      assert.equal(summary.toolCount, 1);
      assert.deepEqual(
        summarizeTurn({ id: 'ask-only', messages: [messages[0]] }).assistant
          ?.parts,
        [ask],
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
    assert.equal(
      summarizeTurn({ id: 'turn', messages: [pending] }).assistant,
      null,
    );
  }
});
