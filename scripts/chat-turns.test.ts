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

test('IntelligentUI remains in the overview without adding an empty details section', () => {
  const panel = {
    type: 'tool-IntelligentUI',
    toolCallId: 'panel',
    state: 'output-available',
    input: { html: '<p>Weather</p>' },
    output: { rendered: true },
  } as const;
  const messages = [
    {
      id: 'assistant',
      role: 'assistant',
      parts: [panel, { type: 'text', text: 'Forecast ready.' }],
    },
  ] as UIMessage[];
  const summary = summarizeTurn({ id: 'turn', messages });
  assert.equal(summary.hasDetails, false);
  assert.equal(summary.toolCount, 1);
  assert.deepEqual(summary.assistant?.parts, [
    panel,
    { type: 'text', text: 'Forecast ready.', state: 'done' },
  ]);
  const pending = summarizeTurn({
    id: 'pending',
    messages: [
      {
        id: 'assistant',
        role: 'assistant',
        parts: [
          {
            type: panel.type,
            toolCallId: panel.toolCallId,
            input: panel.input,
            state: 'input-available',
          },
        ],
      },
    ],
  });
  assert.equal(
    pending.assistant,
    null,
    'pending panels render from the actionable interaction exactly once',
  );
});

test('overview preserves panel order around final text across parts and messages', () => {
  const before = {
    type: 'tool-IntelligentUI',
    toolCallId: 'before',
    state: 'output-available',
    input: { html: '<p>Before</p>' },
    output: { rendered: true },
  } as const;
  const after = { ...before, toolCallId: 'after' };
  const final = { type: 'text', text: 'Final reply', state: 'done' } as const;
  const intermediate = { type: 'text', text: 'Preparing report' } as const;
  const parts = [intermediate, before, final, after];
  for (const messages of [
    [{ id: 'assistant', role: 'assistant' as const, parts }],
    parts.map((part, index) => ({
      id: 'assistant-' + index,
      role: 'assistant' as const,
      parts: [part],
    })),
  ]) {
    const summary = summarizeTurn({ id: 'turn', messages });
    assert.deepEqual(summary.assistant?.parts, [before, final, after]);
    assert.equal(
      summary.hasDetails,
      true,
      'intermediate text is still in details',
    );
    assert.equal(summary.toolCount, 2);
  }
  const panelOnly = summarizeTurn({
    id: 'panel-only',
    messages: [{ id: 'assistant', role: 'assistant', parts: [before, after] }],
  });
  assert.deepEqual(panelOnly.assistant?.parts, [before, after]);
  assert.equal(panelOnly.hasDetails, false);
});
