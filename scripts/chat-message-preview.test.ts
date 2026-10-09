import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupChatMessages,
  groupMessageParts,
} from '../apps/web/src/components/chat/messages.js';
import { getMessageCompression } from '../apps/web/src/components/chat/message-compression.js';
import {
  resolveMessagePart,
  selectMessagePart,
} from '../apps/web/src/components/chat/message-preview/selection.js';

type Message = Parameters<typeof groupMessageParts>[0];
type Part = Message['parts'][number];
const message = (id: string, parts: Part[]): Message => ({
  id,
  role: 'assistant',
  parts,
});
const start = (cycleId = 'cycle'): Part => ({
  type: 'data-om-observation-start',
  data: { cycleId, tokensToObserve: 32496 },
});
const end = (cycleId = 'cycle'): Part => ({
  type: 'data-om-observation-end',
  data: {
    cycleId,
    tokensObserved: 32496,
    observationTokens: 168,
    durationMs: 3497,
    observations: 'Remember this.',
  },
});
const tool = (toolCallId: string): Part => ({
  type: 'dynamic-tool',
  toolName: 'read-file',
  toolCallId,
  state: 'input-available',
  input: { path: 'README.md' },
});

test('compression starts loading and is replaced by one completed checkpoint', () => {
  const beginning = start();
  const finished = end();
  const initial = groupMessageParts(message('one', [beginning]));
  assert.equal(
    initial[0].type === 'compression' && initial[0].compression.status,
    'running',
  );
  const parts = groupMessageParts(message('one', [beginning, finished]));
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], {
    type: 'compression',
    part: finished,
    compression: {
      cycleId: 'cycle',
      status: 'completed',
      tokensBefore: 32496,
      tokensAfter: 168,
      durationMs: 3497,
    },
  });
  assert.deepEqual(groupMessageParts(message('one', [finished])), parts);
});

test('cross-message cycles deduplicate independently without mutating stored messages', () => {
  const sources = [
    message('one', [start('a'), start('b')]),
    message('two', [end('a'), start('a')]),
  ];
  const before = structuredClone(sources);
  const rows = groupChatMessages(sources);
  assert.deepEqual(
    rows
      .flatMap((row) => row.parts)
      .map(
        (part) =>
          part.type === 'compression' && [
            part.compression.cycleId,
            part.compression.status,
          ],
      ),
    [
      ['b', 'running'],
      ['a', 'completed'],
    ],
  );
  assert.deepEqual(sources, before);
  assert.equal(
    groupMessageParts(message('duplicates', [start(), start(), end(), end()]))
      .length,
    1,
  );
});

test('async summaries wait for activation and replay cannot undo a completed checkpoint', () => {
  const beginning: Part = {
    type: 'data-om-buffering-start',
    data: { cycleId: 'buffer', tokensToBuffer: 6454 },
  };
  const buffered: Part = {
    type: 'data-om-buffering-end',
    data: {
      cycleId: 'buffer',
      tokensBuffered: 6454,
      // This is the whole buffer, not this cycle's compressed size.
      bufferedTokens: 5000,
      durationMs: 1000,
      observations: 'Summary pending activation.',
    },
  };
  const activated: Part = {
    type: 'data-om-activation',
    data: {
      cycleId: 'buffer',
      tokensActivated: 6454,
      observationTokens: 1406,
      observations: 'Active summary.',
    },
  };
  const pending = groupMessageParts(message('one', [beginning, buffered]));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, 'compression');
  assert.equal(getMessageCompression(buffered)?.status, 'buffered');
  assert.equal(getMessageCompression(buffered)?.tokensAfter, undefined);
  const sources = [
    message('one', [beginning, buffered]),
    message('two', [activated, buffered, beginning]),
  ];
  const checkpoints = groupChatMessages(sources)
    .flatMap((row) => row.parts)
    .filter((part) => part.type === 'compression');
  assert.equal(checkpoints.length, 1);
  assert.deepEqual(checkpoints[0].compression, {
    cycleId: 'buffer',
    status: 'completed',
    tokensBefore: 6454,
    tokensAfter: 1406,
    durationMs: undefined,
  });
  assert.equal(
    resolveMessagePart(sources, selectMessagePart(sources, beginning)),
    activated,
  );
});

test('both synchronous and asynchronous failures render without leaving a running checkpoint', () => {
  for (const prefix of ['observation', 'buffering']) {
    const beginning: Part = {
      type: `data-om-${prefix}-start`,
      data: { cycleId: 'failed-cycle' },
    };
    const failed: Part = {
      type: `data-om-${prefix}-failed`,
      data: { cycleId: 'failed-cycle', tokensAttempted: 6000, durationMs: 120 },
    };
    const groups = groupMessageParts(
      message('one', [beginning, failed, beginning]),
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].type, 'compression');
    assert.equal(getMessageCompression(failed)?.status, 'failed');
    assert.equal(getMessageCompression(failed)?.tokensBefore, 6000);
  }
});

test('a hidden start does not split tools and completion keeps its position after text', () => {
  const sources = [
    message('one', [
      tool('a'),
      start(),
      tool('b'),
      { type: 'text', text: 'Keep this order.' },
      end(),
    ]),
  ];
  const rows = groupChatMessages(sources);
  assert.deepEqual(
    rows[0].parts.map((part) => part.type),
    ['tools', 'part', 'compression'],
  );
  assert.equal(
    rows[0].parts[0].type === 'tools' && rows[0].parts[0].tools.length,
    2,
  );
});

test('malformed events are ignored and missing or invalid metrics do not fabricate counts', () => {
  for (const data of [null, 'invalid', {}, { cycleId: '' }, { cycleId: 3 }])
    assert.equal(
      getMessageCompression({ type: 'data-om-observation-end', data }),
      null,
    );
  const result = getMessageCompression({
    type: 'data-om-observation-end',
    data: {
      cycleId: 'cycle',
      tokensObserved: 0,
      observationTokens: -1,
      durationMs: Infinity,
    },
  });
  assert.equal(result?.tokensBefore, 0);
  assert.equal(result?.tokensAfter, undefined);
  assert.equal(result?.durationMs, undefined);
});

test('a selected tool resolves its latest output across adjacent grouped messages', () => {
  const initial = tool('b');
  const sources = [message('one', [tool('a')]), message('two', [initial])];
  const selection = selectMessagePart(sources, initial);
  assert.deepEqual(selection, { kind: 'tool', toolCallId: 'b' });
  const updated: Part = {
    type: 'dynamic-tool',
    toolName: 'read-file',
    toolCallId: 'b',
    state: 'output-available',
    input: { path: 'README.md' },
    output: false,
  };
  assert.equal(
    resolveMessagePart([sources[0], message('two', [updated])], selection),
    updated,
  );
  assert.equal(resolveMessagePart([], selection), null);
});

test('a selected compression follows the end event even when it arrives in another message', () => {
  const initial = start();
  const sources = [message('one', [initial])];
  const selection = selectMessagePart(sources, initial);
  assert.equal(resolveMessagePart(sources, selection), initial);
  const finished = end();
  assert.equal(
    resolveMessagePart(
      [...sources, message('two', [finished, start()])],
      selection,
    ),
    finished,
  );
});

test('other data parts resolve by source message identity after history prepends', () => {
  const part: Part = { type: 'data-custom-result', data: { result: 0 } };
  const sources = [message('one', [part])];
  const selection = selectMessagePart(sources, part);
  const updated: Part = { ...part, data: { result: 1 } };
  assert.equal(
    resolveMessagePart(
      [message('older', [tool('old')]), message('one', [updated])],
      selection,
    ),
    updated,
  );
  assert.equal(resolveMessagePart([], selection), null);
  assert.equal(selectMessagePart([], part), null);
});
