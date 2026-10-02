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

test('every non-tool part ends a consecutive tool group without changing message order', () => {
  const separators: Message['parts'] = [
    { type: 'text', text: 'next' },
    { type: 'reasoning', text: 'thinking', state: 'done' },
    { type: 'file', mediaType: 'image/png', url: '/image.png' },
    { type: 'step-start' },
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

test('tools join across adjacent assistant messages and stop at non-tool or user messages', () => {
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
    [['one', 'two'], ['user'], ['three'], ['step'], ['four']],
  );
  assert.deepEqual(
    rows[0].parts.map((group) => group.type),
    ['tools', 'part', 'tools'],
  );
  assert.equal(
    rows[0].parts[0].type === 'tools' && rows[0].parts[0].tools.length,
    2,
  );
  assert.deepEqual(sources, before);
});

test('a growing tool group keeps its identity and a new group gets a separate identity', () => {
  const initial = groupMessageParts(message('one', [tool('a')]));
  const grown = groupMessageParts(message('one', [tool('a'), tool('b')]));
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
