import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatTurnSummary } from '@aime/shared/chat-turns';
import { hasChatTurnDetails } from '@aime/shared/chat-turns';
import type { UIMessage } from 'ai';
import { summarizeTurn } from '../apps/server/src/modules/threads/turns.js';
import { mergeTurns } from '../apps/web/src/components/chat/turns.js';

const turn = (id: string, revision = 'initial'): ChatTurnSummary => ({
  id,
  revision,
  toolCount: 0,
  assetRevision: '',
  user: { id, role: 'user', parts: [{ type: 'text', text: id }] },
  assistant: null,
});

test('a final reply with empty reasoning has no additional details to expand', () => {
  const messages: UIMessage[] = [
    { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
    {
      id: 'assistant',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '', state: 'done' },
        {
          type: 'text',
          text: 'The final reply already shown in the overview.',
        },
        { type: 'step-start' },
        { type: 'text', text: '  ' },
        { type: 'source-url', sourceId: 'source', url: 'https://example.com' },
      ],
    },
  ];
  const summary = summarizeTurn({ id: 'user', messages });
  assert.equal(summary.hasDetails, false);
  assert.equal(hasChatTurnDetails(messages), false);
  assert.deepEqual(summary.assistant?.parts, [
    {
      type: 'text',
      text: 'The final reply already shown in the overview.',
      state: 'done',
    },
  ]);
});

test('details remain available for intermediate text, reasoning, and tool calls', () => {
  const final: UIMessage = {
    id: 'final',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Final reply' }],
  };
  const additions: UIMessage['parts'][number][] = [
    { type: 'text', text: 'An intermediate update' },
    { type: 'reasoning', text: 'Actual reasoning' },
    {
      type: 'tool-read_file',
      toolCallId: 'read',
      state: 'output-available',
      input: {},
      output: 'Read result',
    },
  ];
  for (const part of additions) {
    const messages: UIMessage[] = [
      { id: 'progress', role: 'assistant', parts: [part] },
      final,
    ];
    assert.equal(summarizeTurn({ id: 'turn', messages }).hasDetails, true);
    assert.equal(hasChatTurnDetails(messages), true);
    assert.equal(
      hasChatTurnDetails([{ ...final, parts: [part, ...final.parts] }]),
      true,
    );
  }
});

test('older pages prepend without overriding live updates or duplicating their boundary', () => {
  const live = { ...turn('b', 'live'), cursor: undefined };
  const merged = mergeTurns(
    [live, turn('c')],
    [turn('a'), { ...turn('b'), cursor: 'stored-boundary' }],
    true,
  );
  assert.deepEqual(
    merged.map((item) => item.id),
    ['a', 'b', 'c'],
  );
  assert.equal(merged[1].revision, 'live');
  assert.equal(merged[1].cursor, 'stored-boundary');
});

test('live snapshots replace summaries in place and remove reconciled turns', () => {
  const a = turn('a');
  const result = mergeTurns([a, turn('b')], [turn('b', 'new'), turn('c')]);
  assert.equal(result[0], a);
  assert.deepEqual(
    result.map((item) => item.id),
    ['a', 'b', 'c'],
  );
  assert.equal(result[1].revision, 'new');
  assert.deepEqual(
    mergeTurns(result, [turn('replacement')], false, ['b']).map(
      (item) => item.id,
    ),
    ['a', 'c', 'replacement'],
  );
});
