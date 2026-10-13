import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { convertMessages } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { UIMessage } from 'ai';
import type { ChatSessionEvent } from './session.js';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';
import { fakeMemory } from '../../../../../scripts/fixtures/thread-memory.js';
import { sessionStub } from '../../../../../scripts/fixtures/thread-session.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const toolMessage: UIMessage = {
  id: 'assistant01',
  role: 'assistant',
  parts: [
    {
      type: 'tool-read_file',
      toolCallId: 'read1',
      state: 'output-available',
      input: { path: 'README.md' },
      output: 'Saved tool result',
    },
  ],
};
const history: UIMessage[] = [
  {
    id: 'message01',
    role: 'user',
    parts: [{ type: 'text', text: 'Read and summarize the file' }],
  },
  toolMessage,
];
function stored(messages: UIMessage[], threadId: string) {
  return convertMessages(messages)
    .to('Mastra.V2')
    .map((message, index) => ({
      ...message,
      threadId,
      resourceId: 'user:alice',
      createdAt: new Date(Date.now() - 1000 + index),
    }));
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Continuation did not finish');
}

for (const status of ['success', 'canceled'] as const) {
  test(`continue a ${status} tool turn from persisted history without adding input or replaying the tool`, async (t) => {
    const root = await mkdtemp('/tmp/runner-continue-');
    const storage = new InMemoryStore();
    const memory = new Memory({ storage, options: { generateTitle: false } });
    let requests = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async ({ prompt }) => {
        requests++;
        assert.ok(JSON.stringify(prompt).includes('Saved tool result'));
        assert.equal(
          prompt.filter((message) => message.role === 'user').length,
          1,
        );
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 'text' });
              controller.enqueue({
                type: 'text-delta',
                id: 'text',
                delta: 'Summary of the saved result',
              });
              controller.enqueue({ type: 'text-end', id: 'text' });
              controller.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const runner = createChatRunner(
      new Mastra({ storage, logger: false }),
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
    const service = new ThreadService(memory, runner);
    t.after(async () => {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const thread = await service.createThread('alice', settings);
    await memory.updateThread({
      id: thread.id,
      title: thread.title,
      metadata: { status, error: null },
    });
    await memory.saveMessages({ messages: stored(history, thread.id) });
    await assert.rejects(service.continueRun('bob', thread.id), {
      code: 'THREAD_NOT_FOUND',
    });
    const snapshots: Awaited<ReturnType<ThreadService['getThread']>>[] = [];
    await service.subscribe('alice', thread.id, (snapshot) =>
      snapshots.push(snapshot),
    );
    const accepted = await Promise.all([
      service.continueRun('alice', thread.id),
      service.continueRun('alice', thread.id),
    ]);
    assert.ok(
      accepted.every(
        (thread) => thread.status === 'pending' || thread.status === 'running',
      ),
    );
    await until(
      async () =>
        (await service.getThread('alice', thread.id)).thread.status ===
        'success',
    );
    assert.equal(requests, 1);
    const completed = await service.getThread('alice', thread.id);
    assert.equal(
      completed.messages.filter((message) => message.role === 'user').length,
      1,
    );
    assert.ok(
      completed.messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === 'text' && part.text === 'Summary of the saved result',
        ),
      ),
    );
    assert.ok(
      snapshots.some((snapshot) => snapshot.thread.status === 'running'),
    );
    await assert.rejects(service.continueRun('alice', thread.id), {
      code: 'CONTINUE_UNAVAILABLE',
    });
  });
}

test('continue rejects pending interactions, error states and non-tool endings before opening a session', async (t) => {
  const { memory, threads } = fakeMemory();
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return 'workspace';
    },
    async open() {
      assert.fail('An ineligible continuation must not open a session');
    },
  });
  t.after(() => service.shutdown());
  const pending = {
    id: 'interaction1',
    kind: 'suspended',
    runId: 'run1',
    toolCallId: 'ask1',
    toolName: 'ask_user',
    settings,
  };
  for (const metadata of [
    { status: 'success', error: 'Provider disconnected' },
    { status: 'failed', error: 'Provider disconnected' },
    { status: 'suspended' },
    { status: 'waiting' },
    { status: 'success', toolInteractions: [pending] },
    { status: 'success', toolInteractions: [{ ...pending, kind: 'approval' }] },
  ]) {
    const thread = await service.createThread('alice', settings);
    Object.assign(threads.get(thread.id)!.metadata!, metadata);
    await memory.saveMessages({ messages: stored(history, thread.id) });
    await assert.rejects(service.continueRun('alice', thread.id), {
      code: 'CONTINUE_UNAVAILABLE',
    });
  }
  for (const messages of [
    [],
    [history[0]],
    [
      ...history,
      {
        id: 'final',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done' }],
      },
    ],
  ] satisfies UIMessage[][]) {
    const thread = await service.createThread('alice', settings);
    await memory.saveMessages({ messages: stored(messages, thread.id) });
    await assert.rejects(service.continueRun('alice', thread.id), {
      code: 'CONTINUE_UNAVAILABLE',
    });
  }
});

test('a rejected continuation preserves the stopped turn and permits another attempt', async (t) => {
  const { memory } = fakeMemory();
  let fail = true;
  let emit: (event: ChatSessionEvent) => void = () => {};
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return 'workspace';
    },
    async open({ onEvent }) {
      emit = onEvent;
      return sessionStub({
        async retry() {
          if (fail) throw new Error('Admission failed');
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await memory.saveMessages({ messages: stored(history, thread.id) });
  await assert.rejects(
    service.continueRun('alice', thread.id),
    /Admission failed/,
  );
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.status,
    'idle',
  );
  fail = false;
  assert.equal(
    (await service.continueRun('alice', thread.id)).status,
    'pending',
  );
  emit({ type: 'status', status: 'success', runId: 'continued' });
});
