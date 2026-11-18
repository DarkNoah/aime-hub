import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';

test(
  'chat exec shares the managed tab with the browser panel across model calls',
  {
    skip: process.env.BROWSER_INTEGRATION !== '1',
    timeout: 45000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'exec-browser-chat-'));
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, logger: false });
    const memory = new Memory({ storage, options: { generateTitle: false } });
    const url =
      'data:text/html,' +
      encodeURIComponent('<title>Shared tab</title><input aria-label="Name">');
    const scripts = [
      `import { browser } from 'browser'; await browser.goto(${JSON.stringify(url)}); await browser.click('input'); text(await browser.snapshot());`,
      `import { evaluate } from 'browser'; text(await evaluate('document.querySelector("input").value'));`,
    ];
    let step = 0;
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        const index = step++;
        if (index === 1) {
          // Use the same service entry point as keyboard input from the live panel.
          await service.browserAction('alice', thread.id, {
            kind: 'text',
            text: 'manual-input',
          });
        }
        const code = scripts[index];
        return {
          stream: new ReadableStream({
            start(controller) {
              if (code) {
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'browse-' + index,
                  toolName: 'exec',
                  input: JSON.stringify({ code }),
                });
              } else {
                controller.enqueue({ type: 'text-start', id: 'reply' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'reply',
                  delta: 'Done.',
                });
                controller.enqueue({ type: 'text-end', id: 'reply' });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: code ? 'tool-calls' : 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
          toolCall: true,
          supportsImages: false,
        }),
      } as unknown as LanguageModelService,
      root,
    );
    const service: ThreadService = new ThreadService(memory, runner);
    t.after(async () => {
      await service.shutdown();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const settings = { model: null, reasoningEffort: 'auto' } as const;
    const thread = await service.createThread('alice', {
      ...settings,
      title: 'Browser integration',
    });
    let receiveFrame!: () => void;
    const frame = new Promise<void>((resolve) => {
      receiveFrame = resolve;
    });
    const unsubscribe = await service.subscribeBrowser(
      'alice',
      thread.id,
      (event) => {
        if (
          event.type === 'frame' &&
          Buffer.from(event.frame.data, 'base64').readUInt16BE(0) === 0xffd8
        )
          receiveFrame();
      },
    );
    t.after(unsubscribe);
    await service.run('alice', thread.id, {
      ...settings,
      id: 'browse01',
      isImmediate: false,
      parts: [{ type: 'text', text: 'Open the shared tab' }],
    });
    let snapshot = await service.getThread('alice', thread.id);
    for (
      let i = 0;
      i < 1000 &&
      snapshot.thread.status !== 'success' &&
      snapshot.thread.status !== 'failed';
      i++
    ) {
      await delay(20);
      snapshot = await service.getThread('alice', thread.id);
    }
    assert.equal(
      snapshot.thread.status,
      'success',
      JSON.stringify(snapshot.messages),
    );
    assert.equal(model.doStreamCalls.length, 3);
    for (const call of model.doStreamCalls) {
      assert.ok(call.tools?.some((tool) => tool.name === 'exec'));
      assert.ok(!call.tools?.some((tool) => tool.name.startsWith('browser_')));
    }
    assert.match(JSON.stringify(model.doStreamCalls[1]!.prompt), /textbox/);
    assert.match(
      JSON.stringify(model.doStreamCalls[2]!.prompt),
      /manual-input/,
    );
    assert.equal(
      (await service.getBrowserState('alice', thread.id)).tabs.length,
      1,
    );
    assert.equal((await service.listBrowsers('alice'))[0]?.threadId, thread.id);
    assert.deepEqual(await service.listBrowsers('bob'), []);
    await frame;
  },
);
