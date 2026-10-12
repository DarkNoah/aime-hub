import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupChatMessages,
  groupMessageParts,
} from '../apps/web/src/components/chat/messages.js';

type Message = Parameters<typeof groupMessageParts>[0];
const tool = (id: string): Message['parts'][number] => ({
  type: 'dynamic-tool',
  toolName: 'read-file',
  toolCallId: id,
  state: 'output-available',
  input: { path: id },
  output: { contents: id },
});
const message = (
  id: string,
  parts: Message['parts'],
  role: Message['role'] = 'assistant',
): Message => ({ id, role, parts });

test('content parts end a consecutive tool group without changing message order', () => {
  const separators: Message['parts'] = [
    { type: 'text', text: 'next' },
    { type: 'file', mediaType: 'image/png', url: '/image.png' },
    { type: 'text', text: '' },
  ];
  for (const separator of separators) {
    const source = message('one', [tool('a'), tool('b'), separator, tool('c')]);
    const before = structuredClone(source);
    const groups = groupMessageParts(source);
    assert.deepEqual(
      groups.map((group) => group.type),
      ['tools', 'part', 'tools'],
    );
    assert.equal(groups[0].type === 'tools' && groups[0].tools.length, 2);
    assert.equal(groups[1].type === 'part' && groups[1].part, separator);
    assert.deepEqual(source, before);
  }
});

test('reasoning remains visible while tools on either side stay in one group', () => {
  const reasoning: Message['parts'][number] = {
    type: 'reasoning',
    text: 'thinking',
    state: 'done',
  };
  const sources = [
    message('one', [tool('a')]),
    message('two', [reasoning, tool('b')]),
  ];
  const before = structuredClone(sources);
  const rows = groupChatMessages(sources);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].parts[0], {
    type: 'tools',
    id: 'one:a',
    tools: [tool('a'), tool('b')],
  });
  assert.equal(
    rows[0].parts[1].type === 'part' && rows[0].parts[1].part,
    reasoning,
  );
  assert.deepEqual(sources, before);
});

test('data and step parts do not split tools and remain available for rendering without mutating the source', () => {
  const dataParts: Message['parts'] = [
    { type: 'data-custom', data: { progress: 1 } },
    {
      type: 'data-background-task-completed',
      data: { toolName: 'read-file', result: 'done' },
    },
    {
      type: 'data-om-observation-start',
      data: { cycleId: 'cycle' },
    },
    {
      type: 'data-om-observation-end',
      data: { cycleId: 'cycle' },
    },
    { type: 'step-start' },
  ];
  const source = message('one', [
    tool('a'),
    ...dataParts,
    tool('b'),
    { type: 'text', text: 'answer' },
    tool('c'),
  ]);
  const before = structuredClone(source);
  const groups = groupMessageParts(source);
  assert.deepEqual(
    groups.map((group) => group.type),
    ['tools', 'part', 'part', 'compression', 'part', 'part', 'tools'],
  );
  assert.deepEqual(groups[0], {
    type: 'tools',
    id: 'one:a',
    tools: [tool('a'), tool('b')],
  });
  assert.equal(groups[1].type === 'part' && groups[1].part, dataParts[0]);
  assert.equal(groups[2].type === 'part' && groups[2].part, dataParts[1]);
  assert.equal(
    groups[3].type === 'compression' && groups[3].part,
    dataParts[3],
  );
  assert.equal(groups[4].type === 'part' && groups[4].part, dataParts[4]);
  assert.deepEqual(source, before);
});

test('tools join across assistant messages with data and steps at their edges or in metadata-only messages', () => {
  const data: Message['parts'][number] = { type: 'data-custom', data: {} };
  const step: Message['parts'][number] = { type: 'step-start' };
  const sources = [
    message('one', [tool('a'), data, step]),
    message('two', [step, data, tool('b'), data, step]),
    message('data-one', [data]),
    message('step-only', [step]),
    message('mixed', [data, step]),
    message('three', [step, data, tool('c')]),
  ];
  const before = structuredClone(sources);
  const rows = groupChatMessages(sources);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].sourceIds,
    sources.map((source) => source.id),
  );
  assert.deepEqual(rows[0].parts[0], {
    type: 'tools',
    id: 'one:a',
    tools: [tool('a'), tool('b'), tool('c')],
  });
  assert.deepEqual(
    rows[0].message.parts,
    sources.flatMap((source) => source.parts),
  );
  assert.deepEqual(sources, before);
});

test('ignoring data and steps still respects content, interaction, and message-role boundaries', () => {
  const data: Message['parts'][number] = { type: 'data-custom', data: {} };
  const step: Message['parts'][number] = { type: 'step-start' };
  const separators: Message['parts'] = [
    { type: 'text', text: 'answer' },
    { type: 'file', mediaType: 'image/png', url: '/image.png' },
    {
      type: 'tool-ask_user',
      toolCallId: 'ask',
      state: 'input-available',
      input: {},
    },
    {
      type: 'dynamic-tool',
      toolName: 'ask_user',
      toolCallId: 'ask-dynamic',
      state: 'input-available',
      input: {},
    },
    tool('interactive'),
  ];
  for (const separator of separators) {
    const rows = groupChatMessages(
      [
        message('one', [tool('a'), data, step]),
        message('separator', [step, data, separator, data, step]),
        message('two', [step, data, tool('b')]),
      ],
      new Set(['interactive']),
    );
    const groups = rows
      .flatMap((row) => row.parts)
      .filter((part) => part.type === 'tools');
    assert.deepEqual(
      groups.map((group) => group.tools),
      [[tool('a')], [tool('b')]],
    );
  }
  for (const role of ['user', 'system'] as const) {
    const rows = groupChatMessages([
      message('one', [tool('a'), data, step]),
      message('separator', [data, step], role),
      message('two', [step, data, tool('b')]),
    ]);
    assert.equal(rows.length, 3);
  }
});

test('tools join across assistant messages and steps but stop at content or user messages', () => {
  const sources = [
    message('one', [tool('a')]),
    message('two', [tool('b'), { type: 'text', text: 'answer' }, tool('c')]),
    message('user', [{ type: 'text', text: 'continue' }], 'user'),
    message('three', [tool('d')]),
    message('step', [{ type: 'step-start' }]),
    message('four', [tool('e')]),
  ];
  const before = structuredClone(sources);
  const rows = groupChatMessages(sources);
  assert.deepEqual(
    rows.map((row) => row.sourceIds),
    [['one', 'two'], ['user'], ['three', 'step', 'four']],
  );
  assert.deepEqual(
    rows[0].parts.map((group) => group.type),
    ['tools', 'part', 'tools'],
  );
  assert.equal(
    rows[0].parts[0].type === 'tools' && rows[0].parts[0].tools.length,
    2,
  );
  assert.deepEqual(rows[2].parts[0], {
    type: 'tools',
    id: 'three:d',
    tools: [tool('d'), tool('e')],
  });
  assert.deepEqual(sources, before);
});

test('a growing tool group keeps its identity and a new group gets a separate identity', () => {
  const initial = groupMessageParts(message('one', [tool('a')]));
  const grown = groupMessageParts(
    message('one', [
      tool('a'),
      { type: 'data-custom', data: {} },
      { type: 'step-start' },
      tool('b'),
    ]),
  );
  const next = groupMessageParts(
    message('one', [
      tool('a'),
      tool('b'),
      { type: 'text', text: 'next' },
      tool('c'),
    ]),
  );
  assert.equal(initial[0].type === 'tools' && initial[0].id, 'one:a');
  assert.equal(grown[0].type === 'tools' && grown[0].id, 'one:a');
  assert.equal(next[2].type === 'tools' && next[2].id, 'one:c');
});
