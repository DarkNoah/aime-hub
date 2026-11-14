import assert from 'node:assert/strict';
import test from 'node:test';
import { isToolUIPart, type UIMessage } from 'ai';
import { appendToolGroupPage } from '../apps/web/src/components/chat/tool-group-pages.js';

const tool = (index: number): UIMessage['parts'][number] => ({
  type: 'tool-read_file',
  toolCallId: `call-${index}`,
  state: 'output-available',
  input: { path: `${index}.txt` },
  output: `result-${index}`,
});
const message = (parts: UIMessage['parts']): UIMessage => ({
  id: 'assistant',
  role: 'assistant',
  parts,
});

test('tool group pages append disjoint parts of the same message in execution order', () => {
  const first = [message(Array.from({ length: 20 }, (_, i) => tool(i)))];
  const second = [message(Array.from({ length: 20 }, (_, i) => tool(i + 20)))];
  const merged = appendToolGroupPage(first, second);
  assert.deepEqual(
    merged[0].parts.filter(isToolUIPart).map((part) => part.toolCallId),
    Array.from({ length: 40 }, (_, i) => `call-${i}`),
  );
  assert.equal(first[0].parts.length, 20);
  assert.equal(second[0].parts.length, 20);
});

test('tool group paging preserves reasoning pages and replaces overlapping tools in place', () => {
  const reasoning = { type: 'reasoning', text: 'First reasoning' } as const;
  const merged = appendToolGroupPage(
    [message([reasoning, tool(0)])],
    [message([{ ...tool(0), output: 'updated' } as UIMessage['parts'][number], tool(1)])],
  );
  assert.equal(merged[0].parts.length, 3);
  assert.deepEqual(merged[0].parts[0], reasoning);
  assert.equal(merged[0].parts.filter(isToolUIPart)[0].output, 'updated');
  const fromReasoning = appendToolGroupPage([message([reasoning])], [message([tool(1)])]);
  assert.deepEqual(fromReasoning[0].parts, [reasoning, tool(1)]);
});
