import assert from 'node:assert/strict';
import test from 'node:test';
import type { UIMessage } from 'ai';
import { canContinueThread } from '../packages/shared/src/thread-messages.js';
import type {
  ThreadStatus,
  ToolInteraction,
} from '../packages/shared/src/threads.js';

const tool: UIMessage['parts'][number] = {
  type: 'tool-read_file',
  toolCallId: 'call1',
  state: 'output-available',
  input: { path: 'README.md' },
  output: 'File contents',
};
const message = (
  parts: UIMessage['parts'],
  role: UIMessage['role'] = 'assistant',
): UIMessage => ({
  id: 'message',
  role,
  parts,
});
const stopped = { status: 'success', error: null } as const;
const pending: ToolInteraction = {
  id: 'interaction1',
  kind: 'suspended',
  runId: 'run1',
  toolCallId: 'ask1',
  toolName: 'ask_user',
};

test('stopped static and dynamic tools can continue, including metadata after their results', () => {
  const sources = [
    [message([tool])],
    [message([{ type: 'text', text: 'Reading the file' }, tool])],
    [message([{ ...tool, type: 'dynamic-tool', toolName: 'read_file' }])],
    [
      message([
        tool,
        { type: 'step-start' },
        { type: 'data-progress', data: {} },
      ]),
    ],
    [
      message([tool]),
      message([
        { type: 'data-progress', data: {} },
        { type: 'text', text: '  ' },
      ]),
    ],
    [
      message([
        {
          type: 'tool-read_file',
          toolCallId: 'call1',
          state: 'input-available',
          input: {},
        },
      ]),
    ],
  ];
  for (const messages of sources) {
    const original = structuredClone(messages);
    assert.equal(canContinueThread(messages, stopped), true);
    assert.deepEqual(messages, original);
  }
  assert.equal(
    canContinueThread([message([tool])], { ...stopped, status: 'canceled' }),
    true,
  );
});

test('running, waiting, pending confirmations and errors never show continue', () => {
  const messages = [message([tool])];
  for (const status of [
    'running',
    'pending',
    'waiting',
    'suspended',
  ] satisfies ThreadStatus[])
    assert.equal(canContinueThread(messages, { ...stopped, status }), false);
  assert.equal(canContinueThread(messages, null), false);
  assert.equal(
    canContinueThread(messages, {
      status: 'failed',
      error: 'Provider disconnected',
    }),
    false,
  );
  assert.equal(
    canContinueThread(messages, { ...stopped, error: 'Persisted error' }),
    false,
  );
  for (const kind of ['approval', 'suspended'] as const)
    assert.equal(
      canContinueThread(messages, stopped, [{ ...pending, kind }]),
      false,
    );
  assert.equal(
    canContinueThread(messages, stopped, [
      {
        ...pending,
        response: { id: 'answer01', action: 'resume', data: 'yes' },
      },
    ]),
    true,
  );
  const approval: UIMessage['parts'][number] = {
    type: 'tool-confirm',
    toolCallId: 'approve1',
    state: 'approval-requested',
    input: {},
    approval: { id: 'approval1' },
  };
  assert.equal(canContinueThread([message([approval, tool])], stopped), false);
  assert.equal(
    canContinueThread(
      [
        message([
          {
            type: 'tool-read_file',
            toolCallId: 'call1',
            state: 'output-error',
            input: {},
            errorText: 'Read failed',
          },
        ]),
      ],
      stopped,
    ),
    false,
  );
});

test('text, reasoning, files and user messages after a tool end eligibility', () => {
  for (const part of [
    { type: 'text', text: 'Finished' },
    { type: 'reasoning', text: 'Still thinking' },
    { type: 'file', mediaType: 'image/png', url: '/image.png' },
  ] satisfies UIMessage['parts']) {
    assert.equal(canContinueThread([message([tool, part])], stopped), false);
    assert.equal(
      canContinueThread([message([tool]), message([part])], stopped),
      false,
    );
  }
  assert.equal(
    canContinueThread([message([tool]), message([], 'user')], stopped),
    false,
  );
  assert.equal(canContinueThread([], stopped), false);
  assert.equal(
    canContinueThread(
      [message([{ type: 'data-progress', data: {} }])],
      stopped,
    ),
    false,
  );
});
