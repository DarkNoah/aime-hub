import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { createApp } from '../../app.js';
import { createNodeServer } from '../../server.js';
import type { Auth } from '@aime/auth';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { ThreadBackgroundTask } from '@aime/shared/threads';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';
import { sleep } from '../../mastra/tools/sleep.js';
import type { UIMessage } from 'ai';

for (const cancel of [false, true]) {
  test(`native background sleep updates thread snapshots (cancel=${cancel})`, async (t) => {
    // Explicit test eligibility; the application's sleep may default to foreground.
    const previousBackground = sleep.background;
    sleep.background = { enabled: true };
    t.after(() => {
      sleep.background = previousBackground;
    });
    let interrupted = false;
    const execute = sleep.execute!;
    sleep.execute = async (...args) => {
      try {
        return await execute(...args);
      } finally {
        interrupted = args[1]?.abortSignal?.aborted === true;
      }
    };
    t.after(() => {
      sleep.execute = execute;
    });
    const root = await mkdtemp('/tmp/thread-background-');
    const storage = new InMemoryStore();
    const memory = new Memory({ storage, options: { generateTitle: false } });
    const mastra = new Mastra({
      storage,
      logger: false,
      backgroundTasks: { enabled: true },
    });
    let calls = 0;
    let continuationPrompt = '';
    const model = new MastraLanguageModelV2Mock({
      doStream: async ({ prompt }) => {
        const text = JSON.stringify(prompt);
        if (text.includes('completed successfully:')) continuationPrompt = text;
        return {
          stream: new ReadableStream({
            start(controller) {
              const first = ++calls === 1;
              if (first)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'background-sleep',
                  toolName: 'sleep',
                  input: JSON.stringify({
                    durationMs: cancel ? 5000 : 1500,
                    _background: { disposition: 'deferred' },
                  }),
                });
              else {
                controller.enqueue({ type: 'text-start', id: 'reply' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'reply',
                  delta:
                    calls === 2
                      ? '已在后台启动 sleep。'
                      : '后台 sleep 已完成，耗时 10 秒。',
                });
                controller.enqueue({ type: 'text-end', id: 'reply' });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: first ? 'tool-calls' : 'stop',
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
              });
              controller.close();
            },
          }),
        };
      },
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
    const service = new ThreadService(
      memory,
      native,
      undefined,
      mastra.backgroundTaskManager,
    );
    t.after(async () => {
      await service.shutdown();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const settings = { model: null, reasoningEffort: 'auto' } as const;
    const thread = await service.createThread('alice', settings);
    let tasks: ThreadBackgroundTask[] = [];
    const visible = new Map<string, UIMessage>();
    await service.subscribe('alice', thread.id, (snapshot) => {
      tasks = snapshot.backgroundTasks ?? [];
      for (const id of snapshot.removedMessageIds ?? []) visible.delete(id);
      for (const message of snapshot.messages)
        visible.set(message.id, structuredClone(message));
    });
    await service.run('alice', thread.id, {
      ...settings,
      id: 'message01',
      parts: [{ type: 'text', text: 'sleep in background' }],
      isImmediate: false,
    });
    const waitFor = async (check: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 500; i++) {
        if (await check()) return;
        await delay(10);
      }
      assert.fail(`Timed out waiting for tasks: ${JSON.stringify(tasks)}`);
    };
    await waitFor(() => tasks.some((task) => task.status === 'running'));
    const id = tasks[0].id;
    if (cancel) {
      await service.abort('alice', thread.id);
      // Stopping the foreground turn must leave the runtime observer connected.
      const origin = 'http://localhost:5173';
      const app = createApp(
        {
          api: { getSession: async () => ({ user: { id: 'alice' } }) },
        } as unknown as Auth,
        undefined,
        {
          threads: service,
          models: {} as LanguageModelService,
          webOrigin: origin,
        },
      );
      const server = createNodeServer(app).listen(0, '127.0.0.1');
      t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const endpoint = `http://127.0.0.1:${address.port}/api/threads/${thread.id}/background-tasks/${id}/cancel`;
      const forbidden = await fetch(endpoint, { method: 'POST' });
      assert.equal(forbidden.status, 403);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { origin },
      });
      assert.equal(response.status, 204);
      await waitFor(() => interrupted);
    }
    await waitFor(() =>
      tasks.some(
        (task) =>
          task.id === id &&
          task.status === (cancel ? 'cancelled' : 'completed'),
      ),
    );
    assert.equal(tasks[0].toolName, 'sleep');
    assert.equal(tasks[0].toolCallId, 'background-sleep');
    if (!cancel) {
      assert.equal((tasks[0].result as { status: string }).status, 'completed');
      await waitFor(
        async () =>
          calls >= 3 &&
          (await service.getThread('alice', thread.id)).thread.status ===
            'success',
      );
      assert.match(continuationPrompt, /completedAt/);
      assert.match(continuationPrompt, /Do not call the same tool again/);
      assert.equal(
        (await service.history('alice', thread.id)).messages.filter(
          (message) => message.role === 'user',
        ).length,
        1,
      );
      await delay(100);
      const completionCount = [...visible.values()]
        .flatMap((message) => message.parts)
        .filter(
          (part) =>
            part.type === 'text' &&
            part.text === '后台 sleep 已完成，耗时 10 秒。',
        ).length;
      assert.equal(completionCount, 1);
      assert.deepEqual(
        [...visible.keys()],
        (await service.history('alice', thread.id)).messages.map(
          (message) => message.id,
        ),
      );
    }
    const stored = await mastra.backgroundTaskManager!.getTask(id);
    assert.equal(stored?.threadId, thread.id);
    assert.equal(stored?.resourceId, 'user:alice');
  });
}
