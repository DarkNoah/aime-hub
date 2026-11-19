import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { isToolUIPart } from 'ai';
import type { ChatTurnSnapshot } from '@aime/shared/chat-turns';
import type { ToolInteraction } from '@aime/shared/threads';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';

test('two ask_user calls in one step keep the first answer visible while the second is suspended, including after reopening', (t) =>
  runTwoQuestions(t, 'individual'));
test('one form submission resumes both native questions with null option descriptions in order', (t) =>
  runTwoQuestions(t, 'batch'));

for (const window of [
  'before-interaction',
  'before-status',
  'unrelated-run',
] as const)
  test(`reopen a saved question batch at the ${window} checkpoint`, (t) =>
    runTwoQuestions(t, window));

async function runTwoQuestions(
  t: TestContext,
  mode:
    | 'individual'
    | 'batch'
    | 'before-interaction'
    | 'before-status'
    | 'unrelated-run',
) {
  const root = await mkdtemp('/tmp/thread-double-ask-');
  const storage = new InMemoryStore();
  const mastra = new Mastra({ storage, logger: false });
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const calls = ['format', 'language'];
  const choices: Record<string, string[]> = {
    format: ['PDF', 'HTML'],
    language: ['Chinese', 'English'],
  };
  let requests = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => {
      const ask = ++requests === 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (ask) {
              for (const id of calls)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: id,
                  toolName: 'ask_user',
                  input: JSON.stringify({
                    question: id + '?',
                    ...(mode === 'batch' && {
                      selectionMode: 'single_select',
                      options: choices[id].map((label) => ({
                        label,
                        description: null,
                      })),
                    }),
                  }),
                });
            } else {
              controller.enqueue({ type: 'text-start', id: 'reply' });
              controller.enqueue({
                type: 'text-delta',
                id: 'reply',
                delta: 'Done',
              });
              controller.enqueue({ type: 'text-end', id: 'reply' });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: ask ? 'tool-calls' : 'stop',
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            });
            controller.close();
          },
        }),
      };
    },
  });
  const runner = createChatRunner(
    mastra,
    {
      getLanguageModel: async () => ({
        model,
        reference: 'mock',
        providerOptions: {},
        supportsImages: false,
        toolCall: false,
      }),
    } as unknown as LanguageModelService,
    root,
  );
  let service = new ThreadService(memory, runner);
  t.after(async () => {
    await service.shutdown();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const settings = { model: null, reasoningEffort: 'auto' } as const;
  const thread = await service.createThread('alice', settings);
  const overview = () => service.getThreadOverview('alice', thread.id);
  const tools = (snapshot: ChatTurnSnapshot) =>
    snapshot.turns.flatMap(
      (turn) => turn.assistant?.parts.filter(isToolUIPart) ?? [],
    );
  let latest: ChatTurnSnapshot | undefined;
  const watch = () =>
    service.subscribe(
      'alice',
      thread.id,
      () => {},
      undefined,
      undefined,
      (snapshot, initial) => {
        // Status-only updates carry no turns. The browser keeps the last revision.
        const turns =
          initial || snapshot.turns.length
            ? snapshot.turns
            : (latest?.turns ?? []);
        latest = { ...snapshot, turns };
      },
    );
  const waitFor = async (status: string, pendingId?: string) => {
    for (let i = 0; i < 500; i++) {
      if (
        latest?.thread.status === status &&
        (!pendingId ||
          latest.toolInteractions?.some(
            (item) => item.toolCallId === pendingId,
          )) &&
        tools(latest).length === 2
      )
        return latest;
      await delay(10);
    }
    assert.fail('Missing live snapshot for ' + (pendingId ?? status));
  };
  const disconnect = await watch();
  await service.run('alice', thread.id, {
    ...settings,
    id: 'message01',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Ask both questions' }],
  });
  const first = await waitFor('suspended', 'format');
  assert.deepEqual(
    first.toolInteractions?.map((item) => item.toolCallId),
    ['format'],
  );
  assert.deepEqual(
    tools(first).map((part) => [part.toolCallId, part.state]),
    [
      ['format', 'input-available'],
      ['language', 'input-available'],
    ],
  );
  assert.deepEqual(first.turns.at(-1)?.askUserGroups, [calls]);
  if (mode === 'batch') {
    const interactionId = first.toolInteractions![0].id;
    const answers = [
      {
        toolCallId: 'language',
        response: {
          id: 'language-response',
          action: 'resume' as const,
          data: 'Chinese',
        },
      },
      {
        toolCallId: 'format',
        response: {
          id: 'format-response',
          action: 'resume' as const,
          data: 'PDF',
        },
      },
    ];
    for (const invalid of [
      [answers[1]],
      [answers[1], answers[1]],
      [answers[1], { ...answers[0], toolCallId: 'another-step' }],
      [
        answers[1],
        {
          ...answers[0],
          response: {
            ...answers[0].response,
            data: ['invalid for a single-choice question'],
          },
        },
      ],
    ]) {
      await assert.rejects(
        service.respondToQuestions('alice', thread.id, interactionId, invalid),
        { code: 'VALIDATION_ERROR' },
      );
    }
    await service.respondToQuestions(
      'alice',
      thread.id,
      interactionId,
      answers,
    );
    // Retransmitting a form whose acknowledgement was lost must not resume a call twice.
    await service.respondToQuestions(
      'alice',
      thread.id,
      interactionId,
      answers,
    );
  } else {
    await service.respondToTool(
      'alice',
      thread.id,
      first.toolInteractions![0].id,
      {
        id: 'format-response',
        action: 'resume',
        data: 'PDF',
      },
    );
    const second = await waitFor('suspended', 'language');
    const assertSecond = (snapshot: ChatTurnSnapshot) => {
      assert.deepEqual(
        snapshot.toolInteractions?.map((item) => item.toolCallId),
        ['language'],
      );
      assert.deepEqual(
        tools(snapshot).map((part) => [
          part.toolCallId,
          part.state,
          part.output,
        ]),
        [
          ['format', 'output-available', 'PDF'],
          ['language', 'input-available', undefined],
        ],
      );
    };
    assertSecond(second);
    disconnect();
    await service.shutdown();
    if (mode !== 'individual') {
      // Native storage already contains the second suspension. Simulate the process
      // exiting on either side of writing that interaction to the thread metadata.
      const stored = await memory.getThreadById({ threadId: thread.id });
      assert.ok(stored);
      const interactions = stored.metadata
        ?.toolInteractions as ToolInteraction[];
      const anchor = interactions.find((item) => item.toolCallId === 'format');
      assert.ok(anchor?.turnId && anchor.response);
      const runId = mode === 'unrelated-run' ? 'some-other-run' : anchor.runId;
      await memory.updateThread({
        id: thread.id,
        title: stored.title,
        metadata: {
          status: mode === 'before-status' ? 'running' : 'pending',
          activeId: mode === 'before-status' ? runId : null,
          toolInteractions:
            mode === 'before-status' ? interactions : [{ ...anchor, runId }],
          questionBatch: {
            userId: 'alice',
            turnId: anchor.turnId,
            runId,
            answers: [
              {
                toolCallId: 'language',
                response: {
                  id: 'language-response',
                  action: 'resume',
                  data: 'Chinese',
                },
              },
            ],
          },
        },
      });
      service = new ThreadService(memory, runner);
      if (mode === 'unrelated-run') {
        assert.equal((await overview()).thread.status, 'failed');
        assert.equal(
          (await memory.getThreadById({ threadId: thread.id }))?.metadata
            ?.questionBatch,
          null,
        );
        assert.equal(requests, 1);
        return;
      }
      latest = undefined;
      t.after(await watch());
    } else {
      service = new ThreadService(memory, runner);
      assertSecond(await overview());
      // Earlier versions persisted both interactions without the owning turn ID.
      await service.shutdown();
      const stored = await memory.getThreadById({ threadId: thread.id });
      assert.ok(stored);
      const legacy = (
        stored.metadata?.toolInteractions as ToolInteraction[]
      ).map((interaction) => {
        const copy = { ...interaction };
        delete copy.turnId;
        return copy;
      });
      await memory.updateThread({
        id: thread.id,
        title: stored.title,
        metadata: { toolInteractions: legacy },
      });
      service = new ThreadService(memory, runner);
      assertSecond(await overview());
      const reconnect = await watch();
      t.after(reconnect);
      await service.respondToTool(
        'alice',
        thread.id,
        second.toolInteractions![0].id,
        {
          id: 'language-response',
          action: 'resume',
          data: 'Chinese',
        },
      );
    }
  }
  const done = await waitFor('success');
  assert.deepEqual(done.toolInteractions, []);
  assert.deepEqual(
    tools(done).map((part) => [part.toolCallId, part.state, part.output]),
    [
      ['format', 'output-available', 'PDF'],
      ['language', 'output-available', 'Chinese'],
    ],
  );
  assert.deepEqual(
    model.doStreamCalls
      .at(-1)
      ?.prompt.filter((message) => message.role === 'tool')
      .flatMap((message) => message.content)
      .map((part) => [part.toolCallId, part.output]),
    [
      [
        'format',
        {
          type: 'json',
          value: { content: 'User answered: PDF', isError: false },
        },
      ],
      [
        'language',
        {
          type: 'json',
          value: { content: 'User answered: Chinese', isError: false },
        },
      ],
    ],
  );
  assert.equal(requests, 2);
}
