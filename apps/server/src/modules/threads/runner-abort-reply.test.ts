import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { ChatTurnSummary } from '@aime/shared/chat-turns';
import { threadMessageSourceIds } from '@aime/shared/thread-messages';
import { isToolUIPart, type UIMessage } from 'ai';
import { Pool } from 'pg';
import { createChatStorage } from '../../mastra/storage.js';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(label);
}

function bodyText(message: UIMessage | null) {
  return (
    message?.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? ''
  );
}

const databaseUrl = process.env.TEST_DATABASE_URL;
const backend = databaseUrl ? 'postgres' : 'memory';

for (const { withReasoning, splitText, withTool, providerError = false } of [
  { withReasoning: false, splitText: false, withTool: false },
  { withReasoning: true, splitText: false, withTool: false },
  { withReasoning: true, splitText: true, withTool: false },
  { withReasoning: true, splitText: true, withTool: true },
  {
    withReasoning: true,
    splitText: true,
    withTool: false,
    providerError: true,
  },
]) {
  const interruption = providerError ? 'provider error' : 'user stop';
  test(`${interruption} preserves one partial reply in the live feed and on reconnect (storage=${backend}, reasoning=${withReasoning}, splitText=${splitText}, tool=${withTool})`, async (t) => {
    const introduction = withTool ? 'Checking the clock. ' : '';
    const first = splitText
      ? providerError
        ? 'First paragraph.'
        : 'First paragraph. '
      : '';
    const last = 'A partially streamed answer';
    const body = introduction + first + last;
    const reasoning = 'Considering the question';
    const root = await mkdtemp('/tmp/thread-abort-reply-');
    const pool = databaseUrl
      ? new Pool({ connectionString: databaseUrl })
      : undefined;
    const schema = `abort_reply_${randomUUID().replaceAll('-', '')}`;
    let ownsSchema = false;
    const resources: { service?: ThreadService; mastra?: Mastra } = {};
    t.after(async () => {
      try {
        await resources.service?.shutdown();
        await resources.mastra?.shutdown();
      } finally {
        try {
          if (ownsSchema) await pool!.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await Promise.all([
            pool?.end(),
            rm(root, { recursive: true, force: true }),
          ]);
        }
      }
    });
    if (pool) {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      ownsSchema = true;
    }
    const storage = pool
      ? createChatStorage(pool, schema).storage
      : new InMemoryStore();
    await storage.init();
    const memory = new Memory({ storage, options: { generateTitle: false } });
    const mastra = new Mastra({ storage, logger: false });
    resources.mastra = mastra;
    let requests = 0;
    let failProvider: (() => void) | undefined;
    const failure = new Error('Provider disconnected during the answer');
    const model = new MastraLanguageModelV2Mock({
      doStream: async ({ abortSignal }) => {
        requests++;
        return {
          stream: new ReadableStream({
            start(controller) {
              if (withTool && requests === 1) {
                controller.enqueue({ type: 'text-start', id: 'intro' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'intro',
                  delta: introduction,
                });
                controller.enqueue({ type: 'text-end', id: 'intro' });
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'time',
                  toolName: 'curr_time',
                  input: '{}',
                });
                controller.enqueue({
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
                });
                controller.close();
                return;
              }
              if (withReasoning) {
                controller.enqueue({ type: 'reasoning-start', id: 'thought' });
                controller.enqueue({
                  type: 'reasoning-delta',
                  id: 'thought',
                  delta: reasoning,
                });
                controller.enqueue({ type: 'reasoning-end', id: 'thought' });
              }
              if (splitText) {
                controller.enqueue({ type: 'text-start', id: 'first' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'first',
                  delta: first,
                });
                controller.enqueue({ type: 'text-end', id: 'first' });
              }
              controller.enqueue({ type: 'text-start', id: 'body' });
              controller.enqueue({
                type: 'text-delta',
                id: 'body',
                delta: last,
              });
              failProvider = () => controller.error(failure);
              abortSignal!.addEventListener(
                'abort',
                () =>
                  controller.error(
                    new DOMException('Request canceled', 'AbortError'),
                  ),
                { once: true },
              );
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
    const service = new ThreadService(memory, runner);
    resources.service = service;

    const settings = { model: null, reasoningEffort: 'auto' } as const;
    const thread = await service.createThread('alice', settings);
    const updates: ChatTurnSummary[] = [];
    const unsubscribe = await service.subscribe(
      'alice',
      thread.id,
      () => {},
      undefined,
      undefined,
      (snapshot) => {
        updates.push(...snapshot.turns);
      },
    );
    await service.run('alice', thread.id, {
      ...settings,
      id: 'message01',
      isImmediate: false,
      parts: [{ type: 'text', text: 'Write an answer' }],
    });
    await waitFor(
      () =>
        updates.some(
          (turn) =>
            bodyText(turn.assistant) === body &&
            turn.toolCount === Number(withTool),
        ),
      'No streamed reply',
    );
    if (providerError) {
      assert.ok(failProvider);
      failProvider();
    } else {
      await service.abort('alice', thread.id);
    }

    const savedReplies = async () =>
      (
        await memory.recall({ threadId: thread.id, resourceId: 'user:alice' })
      ).messages.filter((message) => message.role === 'assistant');
    await waitFor(
      async () =>
        (await savedReplies()).some((message) =>
          message.content.parts.some(
            (part) => part.type === 'text' && part.text.includes(last),
          ),
        ),
      'Interrupted output was never saved',
    );
    const saved = await savedReplies();
    if (!withTool) assert.equal(saved.length, 1);
    // Ensure the late native write has reached the public runtime before checking its contents.
    const terminalStatus = providerError ? 'failed' : 'canceled';
    await waitFor(async () => {
      const snapshot = await service.getThread('alice', thread.id);
      return (
        snapshot.thread.status === terminalStatus &&
        snapshot.messages.some((message) =>
          threadMessageSourceIds(message).includes(saved.at(-1)!.id),
        )
      );
    }, 'Stored reply or terminal status did not reach the runtime');
    const runtime = await service.getThread('alice', thread.id);
    assert.equal(runtime.thread.status, terminalStatus);
    assert.equal(runtime.thread.error, providerError ? failure.message : null);
    const history = await service.history('alice', thread.id);
    for (const [source, messages] of [
      ['runtime', runtime.messages],
      ['history', history.messages],
    ] as const) {
      assert.equal(
        messages.filter((message) => message.role === 'user').length,
        1,
      );
      const replies = messages.filter(
        (message) => message.role === 'assistant',
      );
      if (!withTool) assert.equal(replies.length, 1, source);
      assert.equal(replies.map(bodyText).join(''), body, source);
      const tools = replies.flatMap((message) =>
        message.parts.filter(isToolUIPart),
      );
      assert.deepEqual(
        tools.map((part) => [part.toolCallId, part.state]),
        withTool ? [['time', 'output-available']] : [],
      );
    }
    const thoughts = runtime.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === 'reasoning'),
    );
    assert.deepEqual(
      thoughts.map((part) => part.text),
      withReasoning ? [reasoning] : [],
    );

    const overview = await service.getThreadOverview('alice', thread.id);
    assert.equal(overview.turns.length, 1);
    assert.equal(bodyText(overview.turns[0].assistant), body, 'overview');
    assert.equal(overview.turns[0].toolCount, Number(withTool));
    await waitFor(
      () =>
        updates.some((turn) => turn.revision === overview.turns[0].revision),
      'Live subscriber never received the reconciled turn',
    );
    assert.ok(
      updates.every(
        (turn) =>
          body.startsWith(bodyText(turn.assistant)) &&
          turn.toolCount <= Number(withTool),
      ),
    );
    const completeIndex = updates.findIndex(
      (turn) => bodyText(turn.assistant) === body,
    );
    assert.ok(
      updates
        .slice(completeIndex)
        .every((turn) => bodyText(turn.assistant) === body),
    );
    unsubscribe();
    const reconnected: ChatTurnSummary[] = [];
    const disconnect = await service.subscribe(
      'alice',
      thread.id,
      () => {},
      undefined,
      undefined,
      (snapshot, initial) => {
        if (initial) reconnected.push(...snapshot.turns);
      },
    );
    disconnect();
    assert.deepEqual(
      reconnected.map((turn) => [bodyText(turn.assistant), turn.toolCount]),
      [[body, Number(withTool)]],
    );
    assert.equal(requests, withTool ? 2 : 1);
  });
}
