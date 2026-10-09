import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { isToolUIPart, type UIMessage } from 'ai';
import { Pool } from 'pg';
import { sleep } from '../../mastra/tools/sleep.js';
import { createChatStorage } from '../../mastra/storage.js';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';

for (const postgres of [false, true]) {
  for (const [startNextRun, throwOnAbort, delayResult, holdModel] of [
    [false, false, false, false],
    [false, false, false, true],
    [false, false, true, false],
    [true, false, true, false],
    [false, true, true, false],
  ]) {
    test(
      `native cancellation synchronizes saved messages (postgres=${postgres}, next run=${startNextRun}, throws=${throwOnAbort}, delayed=${delayResult}, streaming=${holdModel})`,
      { skip: postgres && !process.env.TEST_DATABASE_URL },
      async (t) => {
        const root = await mkdtemp('/tmp/thread-cancellation-');
        const schema = `cancel_test_${randomBytes(6).toString('hex')}`;
        const pool = postgres
          ? new Pool({ connectionString: process.env.TEST_DATABASE_URL })
          : undefined;
        const storage = pool
          ? createChatStorage(pool, schema).storage
          : new InMemoryStore();
        await storage.init();
        const memory = new Memory({
          storage,
          options: { generateTitle: false },
        });
        const mastra = new Mastra({
          storage,
          logger: false,
          backgroundTasks: { enabled: true },
        });
        const previousExecute = sleep.execute!;
        const previousBackground = sleep.background;
        let started = false;
        let releaseResult!: () => void;
        const resultGate = new Promise<void>((resolve) => {
          releaseResult = resolve;
        });
        sleep.background = undefined;
        sleep.execute = async (...args) => {
          started = true;
          const result = await previousExecute(...args);
          // The outer stream and runner must finish before this result is persisted.
          if (delayResult) await resultGate;
          if (throwOnAbort)
            throw new DOMException('Tool canceled', 'AbortError');
          return result;
        };
        let calls = 0;
        let finishNextRun!: () => void;
        const nextRunGate = new Promise<void>((resolve) => {
          finishNextRun = resolve;
        });
        const model = new MastraLanguageModelV2Mock({
          doStream: async ({ abortSignal }) => ({
            stream: new ReadableStream({
              start(controller) {
                if (++calls === 1) {
                  if (!holdModel) {
                    controller.enqueue({ type: 'text-start', id: 'intro' });
                    controller.enqueue({
                      type: 'text-delta',
                      id: 'intro',
                      delta: 'Waiting.',
                    });
                    controller.enqueue({ type: 'text-end', id: 'intro' });
                  }
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: 'cancel-sleep',
                    toolName: 'sleep',
                    input: JSON.stringify({ durationMs: 5000 }),
                  });
                  if (holdModel) {
                    abortSignal?.addEventListener(
                      'abort',
                      () => {
                        controller.error(
                          new DOMException('Request canceled', 'AbortError'),
                        );
                      },
                      { once: true },
                    );
                    return;
                  }
                }
                controller.enqueue({
                  type: 'finish',
                  finishReason: calls === 1 ? 'tool-calls' : 'stop',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
                controller.close();
              },
            }),
          }),
        });
        const native = createChatRunner(
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
        let persistedUpdates = 0;
        const service = new ThreadService(
          memory,
          {
            ...native,
            open: async (context) => {
              const session = await native.open({
                ...context,
                onEvent: (event) => {
                  if (event.type === 'message' && !event.active)
                    persistedUpdates++;
                  context.onEvent(event);
                },
              });
              return {
                ...session,
                async send(input) {
                  if (input.id !== 'message02') return session.send(input);
                  context.onEvent({
                    type: 'status',
                    status: 'running',
                    runId: 'next-run',
                  });
                  context.onEvent({
                    type: 'message',
                    active: true,
                    message: {
                      id: 'next-response',
                      role: 'assistant',
                      parts: [{ type: 'text', text: 'New turn.' }],
                    },
                  });
                  void nextRunGate.then(() =>
                    context.onEvent({
                      type: 'status',
                      status: 'success',
                      runId: 'next-run',
                    }),
                  );
                },
              };
            },
          },
          undefined,
          mastra.backgroundTaskManager,
        );
        t.after(async () => {
          releaseResult();
          finishNextRun();
          await service.shutdown();
          await mastra.shutdown();
          if (pool) {
            await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
            await pool.end();
          }
          sleep.execute = previousExecute;
          sleep.background = previousBackground;
          await rm(root, { recursive: true, force: true });
        });
        const waitFor = async (check: () => boolean | Promise<boolean>) => {
          for (let i = 0; i < 300; i++) {
            if (await check()) return;
            await delay(10);
          }
          assert.fail(
            'Timed out waiting for cancellation result synchronization',
          );
        };
        const tool = (messages: UIMessage[]) =>
          messages
            .flatMap((m) => m.parts)
            .filter(isToolUIPart)
            .find((part) => part.toolCallId === 'cancel-sleep');
        const settings = { model: null, reasoningEffort: 'auto' } as const;
        const thread = await service.createThread('alice', settings);
        const received = new Map<string, UIMessage>();
        await service.subscribe('alice', thread.id, (snapshot) => {
          for (const message of snapshot.messages)
            received.set(message.id, message);
        });
        await service.run('alice', thread.id, {
          ...settings,
          id: 'message01',
          parts: [{ type: 'text', text: 'Sleep' }],
          isImmediate: false,
        });
        await waitFor(() => started);
        await service.abort('alice', thread.id);
        await waitFor(async () => {
          const snapshot = await service.getThread('alice', thread.id);
          return snapshot.thread.status === 'canceled';
        });
        let activeMessageId: string | null = null;
        if (startNextRun) {
          await service.run('alice', thread.id, {
            ...settings,
            id: 'message02',
            parts: [{ type: 'text', text: 'Continue' }],
            isImmediate: false,
          });
          await waitFor(async () => {
            const snapshot = await service.getThread('alice', thread.id);
            activeMessageId = snapshot.activeMessageId;
            return (
              snapshot.thread.status === 'running' && activeMessageId !== null
            );
          });
        }
        releaseResult();
        if (!throwOnAbort) await waitFor(() => persistedUpdates > 0);
        await waitFor(
          async () =>
            tool((await service.history('alice', thread.id)).messages)
              ?.state ===
            (throwOnAbort ? 'input-available' : 'output-available'),
        );
        await waitFor(
          () =>
            tool([...received.values()])?.state ===
            (throwOnAbort ? 'input-available' : 'output-available'),
        );

        const snapshot = await service.getThread('alice', thread.id);
        const persisted = tool(
          (await service.history('alice', thread.id)).messages,
        );
        // SSE omits undefined optional UI fields; compare the serialized message.
        assert.deepEqual(
          JSON.parse(JSON.stringify(tool(snapshot.messages))),
          JSON.parse(JSON.stringify(persisted)),
        );
        if (throwOnAbort) assert.equal(persisted?.output, undefined);
        else
          assert.equal(
            (persisted?.output as { status: string }).status,
            'aborted',
          );
        assert.equal(
          snapshot.thread.status,
          startNextRun ? 'running' : 'canceled',
        );
        assert.equal(snapshot.activeMessageId, activeMessageId);
        if (!holdModel)
          assert.ok(
            snapshot.messages.some((message) =>
              message.parts.some(
                (part) => part.type === 'text' && part.text === 'Waiting.',
              ),
            ),
          );
        let reconnected: UIMessage[] = [];
        await service.subscribe('alice', thread.id, (value, initial) => {
          if (initial) reconnected = value.messages;
        });
        assert.deepEqual(
          JSON.parse(JSON.stringify(tool(reconnected))),
          JSON.parse(JSON.stringify(persisted)),
        );
        if (startNextRun) {
          finishNextRun();
          await waitFor(
            async () =>
              (await service.getThread('alice', thread.id)).thread.status ===
              'success',
          );
        }
      },
    );
  }
}
