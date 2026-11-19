import assert from 'node:assert/strict';
import test from 'node:test';
import type { UIMessage } from 'ai';
import type { ChatSessionEvent } from './session.js';
import { consumeSessionStream } from './session-stream.js';

test('a failed run reconciles its last text before the open subscription reads another event', async () => {
  const messages = new Map<string, UIMessage>();
  const events: ChatSessionEvent[] = [];
  const reconciled: string[][] = [];
  const error = new Error('Provider stream interrupted');

  async function* stream() {
    const run = { runId: 'first', from: 'AGENT' };
    yield { ...run, type: 'start', payload: { messageId: 'draft' } };
    yield { ...run, type: 'text-start', payload: { id: 'text' } };
    yield {
      ...run,
      type: 'text-delta',
      payload: { id: 'text', text: 'Last partial answer' },
    };
    yield { ...run, type: 'error', payload: { error } };
    // The native subscription now awaits another run. No finish or EOF is required.
    assert.deepEqual(reconciled, [['draft']]);
    assert.deepEqual(events.at(-1), { type: 'error', error, runId: 'first' });
    yield {
      ...run,
      type: 'finish',
      payload: { stepResult: { reason: 'error' }, output: { usage: {} } },
    };
    const next = { runId: 'next', from: 'AGENT' };
    yield { ...next, type: 'start', payload: { messageId: 'reply' } };
    yield { ...next, type: 'text-start', payload: { id: 'text' } };
    yield {
      ...next,
      type: 'text-delta',
      payload: { id: 'text', text: 'Next answer' },
    };
    yield {
      ...next,
      type: 'finish',
      payload: { stepResult: { reason: 'stop' }, output: { usage: {} } },
    };
  }

  await consumeSessionStream(
    {
      stream: stream(),
      activeRunId: () => null,
    } as unknown as Parameters<typeof consumeSessionStream>[0],
    messages,
    () => ({ model: null, reasoningEffort: 'auto' }),
    (event) => events.push(event),
    () => {},
    async (ids) => {
      const message = messages.get(ids[0]);
      const text = message?.parts.find((part) => part.type === 'text');
      assert.equal(
        text?.text,
        ids[0] === 'draft' ? 'Last partial answer' : 'Next answer',
      );
      reconciled.push(ids);
    },
  );
  assert.deepEqual(reconciled, [['draft'], ['reply']]);
  assert.deepEqual([...messages.keys()], ['draft', 'reply']);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.deepEqual(events.at(-1), {
    type: 'status',
    status: 'success',
    runId: 'next',
  });
});
