import assert from 'node:assert/strict';
import test from 'node:test';
import type { UIMessage } from 'ai';
import type { ToolInteraction } from '@aime/shared/threads';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';
import { consumeSessionStream } from '../apps/server/src/modules/threads/session-stream.js';
import { summarizeTurn } from '../apps/server/src/modules/threads/turns.js';

test('pre-filled answers wait for a separate approval, including when the user rejects it', async (t) => {
  const settings = { model: null, reasoningEffort: 'auto' } as const;
  const seen: string[] = [];
  const { memory } = fakeMemory();
  const service = new ThreadService(memory, {
    async createWorkspace() {
      return 'workspace';
    },
    async validate() {},
    async open({ onEvent }) {
      const suspend = (id: string, kind: ToolInteraction['kind']) => {
        onEvent({
          type: 'interaction',
          settings,
          interaction: {
            kind,
            id: kind + '-' + id,
            toolName: 'ask_user',
            toolCallId: id,
            runId: 'run',
            suspendPayload: { question: id },
          },
        });
        onEvent({ type: 'status', status: 'suspended', runId: 'run' });
      };
      return sessionStub({
        async send(input) {
          onEvent({
            type: 'message',
            active: false,
            message: { id: input.id, role: 'user', parts: [] },
          });
          onEvent({
            type: 'message',
            active: true,
            message: {
              id: 'two-questions',
              role: 'assistant',
              parts: ['a', 'b'].map((id) => ({
                type: 'tool-ask_user',
                toolCallId: id,
                state: 'input-available',
                input: { question: id },
              })),
            },
          });
          suspend('a', 'suspended');
        },
        async respond(interaction, response) {
          seen.push(interaction.id + ':' + response.action);
          if (interaction.toolCallId === 'a') suspend('b', 'approval');
          else onEvent({ type: 'status', status: 'success', runId: 'run' });
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, {
    ...settings,
    id: 'twoasks01',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Ask me' }],
  });
  await service.respondToQuestions(
    'alice',
    thread.id,
    'suspended-a',
    ['a', 'b'].map((id) => ({
      toolCallId: id,
      response: { id: 'response-' + id, action: 'resume', data: id },
    })),
  );
  const pending = await service.getThreadOverview('alice', thread.id);
  assert.deepEqual(seen, ['suspended-a:resume']);
  assert.deepEqual(
    pending.toolInteractions?.map((item) => item.id),
    ['approval-b'],
  );
  assert.ok(
    pending.turns[0].assistant?.parts.some(
      (part) =>
        'toolCallId' in part &&
        part.toolCallId === 'b' &&
        part.state === 'input-available',
    ),
  );
  await service.respondToTool('alice', thread.id, 'approval-b', {
    id: 'approval-answer',
    action: 'decline',
  });
  assert.equal(
    (await service.getThreadOverview('alice', thread.id)).thread.status,
    'success',
  );
  assert.deepEqual(seen, ['suspended-a:resume', 'approval-b:decline']);
});

test('only questions declared in the same model step share tabs', () => {
  const ask = (id: string): UIMessage['parts'][number] => ({
    type: 'tool-ask_user',
    toolCallId: id,
    input: { question: id },
    state: 'input-available',
  });
  const messages: UIMessage[] = [
    {
      id: 'first',
      role: 'assistant',
      parts: [
        ask('a'),
        {
          type: 'tool-read_file',
          toolCallId: 'read',
          input: {},
          state: 'input-available',
        },
        {
          type: 'dynamic-tool',
          toolName: 'ask_user',
          toolCallId: 'b',
          input: { question: 'B?' },
          state: 'input-available',
        },
        { type: 'step-start' },
        ask('single'),
      ],
    },
    { id: 'next', role: 'assistant', parts: [ask('c'), ask('d')] },
  ];
  assert.deepEqual(summarizeTurn({ id: 'turn', messages }).askUserGroups, [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('a reopened ask_user run reaches success when the stream resumes without a start event', async () => {
  const runId = 'saved-run';
  const tool = { toolCallId: 'ask', toolName: 'ask_user' };
  const chunks = [
    { type: 'tool-call-suspended', payload: tool },
    { type: 'tool-call-resumed', payload: { ...tool, kind: 'suspension' } },
    { type: 'tool-result', payload: { ...tool, result: 'Daily' } },
    {
      type: 'finish',
      payload: { stepResult: { reason: 'stop' }, output: { usage: {} } },
    },
  ];
  const messages = new Map<string, UIMessage>([
    [
      'answer',
      {
        id: 'answer',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'ask',
            state: 'input-available',
            input: { question: 'Which settings?' },
          },
        ],
      },
    ],
  ]);
  const statuses: string[] = [];
  await consumeSessionStream(
    {
      activeRunId: () => runId,
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks)
            controller.enqueue({ ...chunk, runId, from: 'AGENT' });
          controller.close();
        },
      }),
    } as unknown as Parameters<typeof consumeSessionStream>[0],
    messages,
    () => ({ model: null, reasoningEffort: 'auto' }),
    (event) => {
      if (event.type === 'error') assert.fail(String(event.error));
      if (event.type === 'status') {
        assert.equal(event.runId, runId);
        statuses.push(event.status);
      }
    },
    () => {},
    async () => {},
  );
  assert.deepEqual(statuses, ['running', 'success']);
  assert.ok(
    messages
      .get('answer')
      ?.parts.some((part) => 'output' in part && part.output === 'Daily'),
  );
});

test('answered ask_user cards remain in the overview in order without adding empty details', () => {
  for (const identity of [
    { type: 'tool-ask_user' as const },
    { type: 'dynamic-tool' as const, toolName: 'ask_user' },
  ]) {
    for (const result of [
      { state: 'output-available' as const, output: 'Daily' },
      { state: 'output-available' as const, output: ['Daily', 'Points'] },
      {
        state: 'output-denied' as const,
        approval: { id: 'declined', approved: false as const },
      },
    ]) {
      const ask = {
        ...identity,
        toolCallId: 'ask',
        input: { question: 'Which settings?' },
        ...result,
      };
      const final = {
        type: 'text' as const,
        text: 'Continuing.',
        state: 'done' as const,
      };
      const messages: UIMessage[] = [
        { id: 'answer', role: 'assistant', parts: [ask] },
        { id: 'final', role: 'assistant', parts: [final] },
      ];
      const summary = summarizeTurn({ id: 'turn', messages });
      assert.deepEqual(summary.assistant?.parts, [
        { ...ask, forceRender: true },
        final,
      ]);
      assert.equal(summary.hasDetails, false);
      assert.equal(summary.toolCount, 1);
      assert.deepEqual(
        summarizeTurn({ id: 'ask-only', messages: [messages[0]] }).assistant
          ?.parts,
        [{ ...ask, forceRender: true }],
        'an answered question is visible even before the next assistant text',
      );
    }
    const pending: UIMessage = {
      id: 'pending',
      role: 'assistant',
      parts: [
        {
          ...identity,
          toolCallId: 'ask',
          state: 'input-available',
          input: { question: 'Which settings?' },
        },
      ],
    };
    assert.deepEqual(
      summarizeTurn({ id: 'turn', messages: [pending] }).assistant?.parts,
      [{ ...pending.parts[0], forceRender: true }],
      'pending forced tools remain in the overview; the UI deduplicates actionable cards',
    );
  }
});

test('a declined ask stays declined when the native tool publishes its final result', () => {
  const ask = {
    type: 'tool-ask_user' as const,
    toolCallId: 'ask',
    input: { question: 'Which settings?' },
    state: 'output-available' as const,
    output: {
      content: 'User answered: The user declined to answer this question.',
      isError: false,
    },
  };
  const messages: UIMessage[] = [
    { id: 'answer', role: 'assistant', parts: [ask] },
  ];
  const response = { id: 'declined', action: 'decline' as const };
  const summary = summarizeTurn({ id: 'turn', messages }, undefined, {
    askUserResponses: new Map([[ask.toolCallId, response]]),
  });
  assert.deepEqual(summary.assistant?.parts, [
    {
      type: ask.type,
      toolCallId: ask.toolCallId,
      input: ask.input,
      state: 'output-denied',
      approval: { id: response.id, approved: false, reason: undefined },
      forceRender: true,
    },
  ]);
  assert.equal(ask.state, 'output-available');
});
