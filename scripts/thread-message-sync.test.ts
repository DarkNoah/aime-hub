import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeMessages } from '../apps/web/src/components/chat/messages.js';

type Message = Parameters<typeof mergeMessages>[0][number];
const pending: Message = {
  id: 'assistant',
  role: 'assistant',
  parts: [
    {
      type: 'tool-sleep',
      toolCallId: 'sleep-call',
      state: 'input-available',
      input: { durationMs: 10000 },
    },
  ],
};
const completed: Message = {
  ...pending,
  parts: [
    {
      type: 'tool-sleep',
      toolCallId: 'sleep-call',
      state: 'output-available',
      input: { durationMs: 10000 },
      output: { status: 'aborted' },
    },
  ],
};

test('an old SSE snapshot cannot remove a tool result loaded from history', () => {
  assert.deepEqual(mergeMessages([completed], [pending]), [completed]);
  assert.deepEqual(mergeMessages([pending], [completed]), [completed]);
  assert.deepEqual(mergeMessages([pending], [completed], true), [completed]);
});

test('a completed turn removes its stream-only ID while preserving history and identical replies', () => {
  const text = {
    type: 'text' as const,
    text: '后台 sleep 已完成，耗时 10 秒。',
  };
  const older: Message = {
    id: 'older-reply',
    role: 'assistant',
    parts: [text],
  };
  const streamed: Message = {
    id: 'temporary-reply',
    role: 'assistant',
    parts: [text],
  };
  const persisted: Message = {
    ...completed,
    parts: [...completed.parts, text],
  };
  assert.deepEqual(
    mergeMessages([older, pending, streamed], [persisted], false, [
      streamed.id,
    ]),
    [older, persisted],
  );
});

test('retaining a tool result still accepts newer text and other tool results', () => {
  const incoming: Message = {
    ...pending,
    parts: [...pending.parts, { type: 'text', text: 'Next step' }],
  };
  const before = structuredClone([completed, incoming]);
  assert.deepEqual(mergeMessages([completed], [incoming])[0].parts, [
    ...completed.parts,
    { type: 'text', text: 'Next step' },
  ]);
  assert.deepEqual([completed, incoming], before);
});

test('a newer output replaces an earlier output, including a background acknowledgement', () => {
  const latest: Message = {
    ...completed,
    parts: [
      {
        type: 'tool-sleep',
        toolCallId: 'sleep-call',
        state: 'output-available',
        input: {},
        output: { status: 'completed' },
      },
    ],
  };
  assert.deepEqual(mergeMessages([completed], [latest]), [latest]);
});

test('a snapshot from before the tool call cannot erase its persisted result', () => {
  assert.deepEqual(mergeMessages([completed], [{ ...pending, parts: [] }]), [
    completed,
  ]);
});

test('stale snapshots preserve error and denied results without freezing preliminary output', () => {
  for (const part of [
    {
      type: 'tool-sleep',
      toolCallId: 'sleep-call',
      state: 'output-error',
      input: {},
      errorText: 'Failed',
    },
    {
      type: 'tool-sleep',
      toolCallId: 'sleep-call',
      state: 'output-denied',
      input: {},
      approval: { id: 'approval', approved: false },
    },
  ] satisfies Message['parts']) {
    const previous = { ...completed, parts: [part] };
    assert.deepEqual(mergeMessages([previous], [pending]), [previous]);
  }
  const preliminary: Message = {
    ...completed,
    parts: [
      {
        type: 'tool-sleep',
        toolCallId: 'sleep-call',
        state: 'output-available',
        input: {},
        output: 'progress',
        preliminary: true,
      },
    ],
  };
  assert.deepEqual(mergeMessages([preliminary], [completed]), [completed]);
  assert.deepEqual(mergeMessages([completed], [preliminary]), [completed]);
});

const datedMessage = (index: number): Message => ({
  id: `message-${index}`,
  role: index % 2 ? 'assistant' : 'user',
  metadata: { createdAt: new Date(1_700_000_000_000 + index).toISOString() },
  parts: [{ type: 'text', text: `Message ${index}` }],
});

test('a wider SSE snapshot keeps the first message above the latest history page', () => {
  const all = Array.from({ length: 41 }, (_, index) => datedMessage(index));
  const page = all.slice(-40);
  const before = structuredClone([page, all]);
  const initial = mergeMessages(page, all);

  assert.deepEqual(initial, all);
  assert.deepEqual(mergeMessages(initial, all.slice(0, 1), true), all);
  assert.deepEqual([page, all], before);
});

test('a stale runtime window and sparse late updates keep their chronological position', () => {
  const all = Array.from({ length: 85 }, (_, index) => datedMessage(index));
  const latest = all.slice(-40);
  const snapshot = mergeMessages(latest, all.slice(0, 40));
  assert.deepEqual(snapshot, [...all.slice(0, 40), ...latest]);
  assert.deepEqual(mergeMessages(snapshot, all.slice(40, 45)), all);
  assert.deepEqual(mergeMessages(snapshot, all.slice(0, 45), true), all);
});

test('undated streaming replies stay between their neighboring user messages', () => {
  const firstUser = datedMessage(2);
  const nextUser = datedMessage(4);
  const firstReply: Message = { ...datedMessage(3), metadata: undefined };
  const nextReply: Message = { ...datedMessage(5), metadata: undefined };
  const current = [firstUser, firstReply, nextUser, nextReply];
  const older = datedMessage(0);

  assert.deepEqual(mergeMessages(current, [older]), [older, ...current]);
  assert.deepEqual(mergeMessages(current, [older], true), [older, ...current]);
});

test('an old message and a fresh draft in the same SSE batch do not move the draft into history', () => {
  const latest = datedMessage(2);
  const older = datedMessage(0);
  const draft: Message = { ...datedMessage(3), metadata: undefined };
  assert.deepEqual(mergeMessages([latest], [older, draft]), [
    older,
    latest,
    draft,
  ]);
});

test('stream updates preserve the stored creation time used for ordering', () => {
  const older = datedMessage(1);
  const latest = datedMessage(2);
  const update: Message = {
    ...older,
    metadata: { streaming: true },
    parts: [{ type: 'text', text: 'Updated reply' }],
  };
  assert.deepEqual(mergeMessages([latest, older], [update]), [
    { ...update, metadata: { ...older.metadata!, ...update.metadata! } },
    latest,
  ]);
});

test('equal or missing creation times preserve sequence and live content on older-page merges', () => {
  const first = datedMessage(0);
  const second = { ...datedMessage(1), metadata: first.metadata };
  const draft: Message = { ...datedMessage(2), metadata: undefined };
  const update = {
    ...second,
    parts: [{ type: 'text' as const, text: 'Live' }],
  };
  const current = [update, draft];

  assert.deepEqual(mergeMessages(current, [first, second], true), [
    first,
    update,
    draft,
  ]);
  assert.deepEqual(mergeMessages([first, second, draft], [update]), [
    first,
    update,
    draft,
  ]);
});
