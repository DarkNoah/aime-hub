import assert from 'node:assert/strict';
import test from 'node:test';
import { isToolUIPart, type UIMessage } from 'ai';
import {
  mergeThreadMessages,
  reconcileThreadMessages,
  threadMessageSourceIds,
} from '@aime/shared/thread-messages';
import {
  groupChatMessages,
  mergeMessages,
} from '../apps/web/src/components/chat/messages.js';
import {
  call,
  overlappingMessages,
} from './fixtures/thread-message-overlap.js';

const texts = (messages: UIMessage[]) =>
  messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'text')
    .map((p) => p.text);
const tools = (messages: UIMessage[]) =>
  messages.flatMap((m) => m.parts).filter(isToolUIPart);

for (const draftFirst of [false, true]) {
  test(`running overlapping snapshots have one copy of each call/text and retain the unsaved suffix (draft first=${draftFirst})`, () => {
    const { persisted, draft } = overlappingMessages();
    const before = structuredClone([persisted, draft]);
    const messages = draftFirst
      ? mergeMessages([draft], [persisted])
      : mergeMessages([persisted], [draft]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, persisted.id);
    assert.deepEqual(
      new Set(threadMessageSourceIds(messages[0])),
      new Set([persisted.id, draft.id]),
    );
    assert.deepEqual(texts(messages), [
      'Starting',
      'Intermediate findings',
      'Not saved yet',
    ]);
    assert.equal(tools(messages).length, 17);
    assert.equal(new Set(tools(messages).map((p) => p.toolCallId)).size, 17);
    assert.ok(
      messages[0].parts.some(
        (p) => p.type === 'file' && p.url === '/unsaved.png',
      ),
    );
    const rows = groupChatMessages(messages);
    const groups = rows.flatMap((r) =>
      r.parts.filter((p) => p.type === 'tools'),
    );
    assert.deepEqual(
      groups.map((g) => g.tools.length),
      [9, 7, 1],
    );
    assert.equal(new Set(groups.map((g) => g.id)).size, groups.length);
    assert.ok(rows[0].sourceIds.includes(draft.id));
    assert.deepEqual([persisted, draft], before);
  });
}

test('old saved snapshots and repeated aliases cannot erase a growing draft or accumulate groups', () => {
  const { persisted, draft } = overlappingMessages();
  let messages = mergeMessages([persisted], [draft]);
  for (let i = 0; i < 40; i++) {
    const update: UIMessage = {
      ...draft,
      parts: draft.parts.map((p) =>
        p.type === 'text' && p.text === 'Not saved yet'
          ? { ...p, text: `Not saved yet${'.'.repeat(i + 1)}` }
          : p,
      ),
    };
    messages = mergeMessages(messages, [update]);
    messages = mergeMessages(messages, [persisted]);
    messages = mergeMessages(messages, [draft]);
    assert.equal(messages.length, 1);
    assert.equal(tools(messages).length, 17);
    assert.equal(texts(messages).at(-1), `Not saved yet${'.'.repeat(i + 1)}`);
    assert.equal(
      groupChatMessages(messages)[0].parts.filter((p) => p.type === 'tools')
        .length,
      3,
    );
  }
});

test('cancel reconciliation keeps unsaved text, attachments and tool input even when the draft ID is absent from storage', () => {
  const { persisted, draft } = overlappingMessages();
  const reconciled = reconcileThreadMessages([draft], [persisted], [draft.id]);
  assert.deepEqual(texts(reconciled), [
    'Starting',
    'Intermediate findings',
    'Not saved yet',
  ]);
  assert.equal(tools(reconciled).at(-1)?.state, 'input-streaming');
  assert.ok(reconciled[0].parts.some((p) => p.type === 'file'));
  const late = { ...persisted, parts: [...persisted.parts, call('new-call')] };
  const updated = mergeMessages(reconciled, [late]);
  assert.equal(tools(updated).at(-1)?.state, 'output-available');
  assert.equal(tools(updated).length, 17);
  assert.ok(texts(updated).includes('Not saved yet'));
});

test('a shorter persisted snapshot with the same ID keeps unfinished text and new parts during streaming and cancellation', () => {
  const persisted: UIMessage = {
    id: 'same-id',
    role: 'assistant',
    metadata: { createdAt: '2026-10-13T12:41:20Z' },
    parts: [call('one'), { type: 'text', text: 'Partial' }],
  };
  const draft: UIMessage = {
    ...persisted,
    metadata: undefined,
    parts: [
      call('one'),
      { type: 'text', text: 'Partial with unsaved text', state: 'streaming' },
      { type: 'file', mediaType: 'image/png', url: '/unsaved.png' },
      {
        type: 'tool-exec',
        toolCallId: 'new',
        state: 'input-available',
        input: { command: 'echo ready' },
      },
    ],
  };
  for (const result of [
    mergeMessages([draft], [persisted]),
    reconcileThreadMessages([draft], [persisted], [draft.id]),
  ]) {
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].parts, draft.parts);
    assert.deepEqual(result[0].metadata, persisted.metadata);
  }
});

test('provider item IDs merge partial text across source IDs but equal unrelated replies remain separate', () => {
  const text = (
    value: string,
    id = 'provider-text',
  ): UIMessage['parts'][number] => ({
    type: 'text',
    text: value,
    providerMetadata: { openai: { itemId: id } },
  });
  const stored: UIMessage = {
    id: 'stored',
    role: 'assistant',
    parts: [text('Partial')],
  };
  const live: UIMessage = {
    id: 'live',
    role: 'assistant',
    parts: [text('Partial text')],
  };
  assert.deepEqual(texts(mergeMessages([stored], [live])), ['Partial text']);
  assert.equal(
    mergeMessages([stored], [{ ...live, parts: [text('Partial', 'other')] }])
      .length,
    2,
  );
  assert.equal(
    reconcileThreadMessages(
      [{ ...live, parts: [text('Partial', 'other')] }],
      [stored],
      [live.id],
    ).length,
    2,
  );
  assert.equal(
    mergeMessages(
      [{ ...stored, parts: [{ type: 'text', text: 'Same' }] }],
      [{ ...live, parts: [{ type: 'text', text: 'Same' }] }],
    ).length,
    2,
  );
  const user: UIMessage = {
    id: 'user',
    role: 'user',
    parts: [{ type: 'text', text: 'Again' }],
  };
  assert.equal(mergeThreadMessages([], [stored, user, live]).length, 3);
});

test('finishing a text-only alias retains older identical answers and an unpersisted distinct draft', () => {
  const part = { type: 'text' as const, text: 'Done' };
  const older: UIMessage = { id: 'older', role: 'assistant', parts: [part] };
  const user: UIMessage = {
    id: 'user',
    role: 'user',
    parts: [{ type: 'text', text: 'Next' }],
  };
  const saved: UIMessage = {
    id: 'saved',
    role: 'assistant',
    metadata: { createdAt: '2026-10-13T12:41:20Z' },
    parts: [call('one'), part],
  };
  const draft: UIMessage = { id: 'draft', role: 'assistant', parts: [part] };
  const unique: UIMessage = {
    id: 'unique',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Still unsaved' }],
  };
  const result = reconcileThreadMessages(
    [older, user, draft, unique],
    [older, user, saved],
    [draft.id, unique.id],
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ['older', 'user', 'saved', 'unique'],
  );
  assert.equal(texts(result).filter((text) => text === 'Done').length, 2);
  assert.ok(threadMessageSourceIds(result[2]).includes(draft.id));
});

test('coalesced IDs remain addressable for late results after a new user turn', () => {
  const { persisted, draft } = overlappingMessages();
  const user: UIMessage = {
    id: 'next-user',
    role: 'user',
    parts: [{ type: 'text', text: 'Next' }],
  };
  const current = [...mergeMessages([persisted], [draft]), user];
  const late = {
    ...draft,
    parts: [...draft.parts.slice(0, -1), call('new-call')],
  };
  const updated = mergeMessages(current, [late]);
  assert.deepEqual(
    updated.map((m) => m.id),
    [persisted.id, user.id],
  );
  assert.equal(tools(updated).at(-1)?.state, 'output-available');
});

test('reconnect source IDs merge a text-only draft with its saved identity across a new turn', () => {
  const draft: UIMessage = {
    id: 'text-draft',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Partial answer with an unsaved suffix' }],
  };
  const saved: UIMessage = {
    id: 'text-saved',
    role: 'assistant',
    metadata: {
      createdAt: '2026-10-13T12:41:20Z',
      reconciledMessageIds: [draft.id, 'text-saved'],
    },
    parts: [{ type: 'text', text: 'Partial answer' }],
  };
  const user: UIMessage = {
    id: 'next-user',
    role: 'user',
    metadata: { createdAt: '2026-10-13T12:42:20Z' },
    parts: [{ type: 'text', text: 'Next' }],
  };
  for (const current of [
    [draft, user],
    [saved, draft, user],
  ]) {
    const result = mergeMessages(current, [saved]);
    assert.deepEqual(
      result.map((m) => m.id),
      [saved.id, user.id],
    );
    assert.deepEqual(texts(result), [
      'Partial answer with an unsaved suffix',
      'Next',
    ]);
  }
});
