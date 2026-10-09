import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';
import { createApp } from '../../app.js';
import type { ChatSettings } from '@aime/shared/threads';
import type { LanguageModelService } from '../models/language-model.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = (id: string, isImmediate = false) => ({
  ...settings,
  id,
  isImmediate,
  parts: [{ type: 'text' as const, text: id }],
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Native thread state did not settle');
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(
  t: TestContext,
  run: NonNullable<
    ConstructorParameters<typeof MastraLanguageModelV2Mock>[0]
  >['doStream'],
) {
  const root = await mkdtemp('/tmp/native-queue-');
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const mastra = new Mastra({
    storage,
    logger: false,
    backgroundTasks: { enabled: true },
  });
  const model = new MastraLanguageModelV2Mock({ doStream: run });
  const runner = createChatRunner(
    mastra,
    {
      getLanguageModel: async (_userId: string, selected: ChatSettings) => ({
        model,
        reference: selected.model ?? 'mock',
        maxOutputTokens: selected.model === 'mock/second' ? 222 : 111,
        providerOptions: {},
        supportsImages: true,
        toolCall: false,
      }),
    } as unknown as LanguageModelService,
    root,
  );
  const service = new ThreadService(
    memory,
    runner,
    undefined,
    mastra.backgroundTaskManager,
  );
  t.after(async () => {
    await service.shutdown();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const thread = await service.createThread('alice', settings);
  return { service, thread, memory, runner };
}
function reply(text: string) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 'text' });
        controller.enqueue({ type: 'text-delta', id: 'text', delta: text });
        controller.enqueue({ type: 'text-end', id: 'text' });
        controller.enqueue({
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        controller.close();
      },
    }),
  };
}

test('native FIFO owns scheduling, preserves user IDs and separates assistant turns', async (t) => {
  const first = gate();
  const second = gate();
  t.after(() => {
    first.release();
    second.release();
  });
  const prompts: string[] = [];
  const { service, thread, memory } = await fixture(t, async ({ prompt }) => {
    const call = prompts.push(JSON.stringify(prompt));
    if (call === 1) await first.promise;
    if (call === 2) await second.promise;
    return reply(`answer-${call}`);
  });
  await service.run('alice', thread.id, input('message01'));
  await until(() => prompts.length === 1);
  await service.run('alice', thread.id, input('message02'));
  await service.run('alice', thread.id, input('message03'));
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.queueCount === 2,
  );
  assert.equal(prompts.length, 1);
  assert.equal(
    (await memory.getThreadById({ threadId: thread.id }))?.metadata?.queue,
    undefined,
  );
  first.release();
  await until(() => prompts.length === 2);
  assert.match(prompts[1], /message02/);
  assert.doesNotMatch(prompts[1], /message03/);
  second.release();
  await until(
    async () =>
      prompts.length === 3 &&
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  const snapshot = await service.getThread('alice', thread.id);
  assert.equal(snapshot.thread.queueCount, 0);
  assert.deepEqual(
    snapshot.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.id),
    ['message01', 'message02', 'message03'],
  );
  assert.deepEqual(
    snapshot.messages
      .filter((message) => message.role === 'assistant')
      .map((message) =>
        message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
      ),
    ['answer-1', 'answer-2', 'answer-3'],
  );
  const history = await service.history('alice', thread.id);
  assert.deepEqual(
    history.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.id),
    ['message01', 'message02', 'message03'],
  );
});

test('clearing native pending input does not abort the active reply', async (t) => {
  const first = gate();
  t.after(first.release);
  let calls = 0;
  const { service, thread } = await fixture(t, async () => {
    calls++;
    await first.promise;
    return reply('done');
  });
  await service.run('alice', thread.id, input('message01'));
  await until(() => calls === 1);
  await service.run('alice', thread.id, input('message02'));
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.queueCount === 1,
  );
  await assert.rejects(service.clearQueue('bob', thread.id), {
    code: 'THREAD_NOT_FOUND',
  });
  await service.clearQueue('alice', thread.id);
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.queueCount === 0,
  );
  first.release();
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.equal(calls, 1);
});

test('immediate input enters the next step while normal input stays FIFO; disconnect does not stop either', async (t) => {
  const first = gate();
  const second = gate();
  t.after(() => {
    first.release();
    second.release();
  });
  const prompts: string[] = [];
  const { service, thread } = await fixture(t, async ({ prompt }) => {
    const call = prompts.push(JSON.stringify(prompt));
    if (call === 1) {
      await first.promise;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'time-1',
              toolName: 'curr_time',
              input: '{}',
            });
            controller.enqueue({
              type: 'finish',
              finishReason: 'tool-calls',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    }
    if (call === 2) await second.promise;
    return reply(`answer-${call}`);
  });
  const disconnect = await service.subscribe('alice', thread.id, () => {});
  await service.run('alice', thread.id, input('message01'));
  await until(() => prompts.length === 1);
  await service.run('alice', thread.id, input('queued001'));
  await service.run('alice', thread.id, input('instant01'));
  await service.updateQueued('alice', thread.id, 'instant01', {
    isImmediate: true,
  });
  await service.updateQueued('alice', thread.id, 'instant01', {
    text: 'Revised immediate input',
  });
  disconnect();
  first.release();
  await until(() => prompts.length === 2);
  assert.match(prompts[1], /Revised immediate input/);
  assert.doesNotMatch(prompts[1], /instant01/);
  assert.doesNotMatch(prompts[1], /queued001/);
  second.release();
  await until(
    async () =>
      prompts.length === 3 &&
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.match(prompts[2], /queued001/);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.queueCount,
    0,
  );
});

test('stop clears the native queue and a later submission opens a new run', async (t) => {
  let calls = 0;
  const { service, thread } = await fixture(t, async ({ abortSignal }) => {
    if (++calls === 1) {
      await new Promise<void>((resolve) =>
        abortSignal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new Error('Request aborted');
    }
    return reply('new reply');
  });
  await service.run('alice', thread.id, input('message01'));
  await until(() => calls === 1);
  await service.run('alice', thread.id, input('queued001'));
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.queueCount === 1,
  );
  await service.abort('alice', thread.id);
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.queueCount === 0,
  );
  assert.equal(calls, 1);
  await service.run('alice', thread.id, input('message02'));
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.equal(calls, 2);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.error,
    null,
  );
});

test('native failure can be retried after reopening without duplicating the user signal', async (t) => {
  let fail = true;
  const prompts: string[] = [];
  const { service, thread, memory, runner } = await fixture(
    t,
    async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      if (fail) throw new Error('Provider unavailable');
      return reply('Recovered');
    },
  );
  await service.run('alice', thread.id, input('message01'));
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status === 'failed',
  );
  await service.shutdown();
  fail = false;
  const reopened = new ThreadService(memory, runner);
  t.after(() => reopened.shutdown());
  await Promise.all([
    reopened.retry('alice', thread.id),
    reopened.retry('alice', thread.id),
  ]);
  await until(
    async () =>
      (await reopened.getThread('alice', thread.id)).thread.status ===
      'success',
  );
  const history = await reopened.history('alice', thread.id);
  assert.equal(
    history.messages.filter((message) => message.role === 'user').length,
    1,
  );
  assert.match(prompts.at(-1)!, /message01/);
});

test('queued signals retain attachments, authors and per-message model settings', async (t) => {
  const first = gate();
  t.after(first.release);
  const limits: (number | undefined)[] = [];
  const { service, thread } = await fixture(t, async ({ maxOutputTokens }) => {
    limits.push(maxOutputTokens);
    if (limits.length === 1) await first.promise;
    return reply('done');
  });
  await service.run('alice', thread.id, input('message01'));
  await until(() => limits.length === 1);
  const file = {
    type: 'file',
    mediaType: 'image/png',
    filename: 'sample.png',
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT5kAAAAASUVORK5CYII=',
  } as const;
  await service.run('alice', thread.id, {
    ...input('message02'),
    model: 'mock/second',
    createdBy: 'alice',
    parts: [{ type: 'text', text: 'Describe' }, file],
  });
  first.release();
  await until(
    async () =>
      limits.length === 2 &&
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.deepEqual(limits, [111, 222]);
  const message = (await service.history('alice', thread.id)).messages.find(
    (message) => message.id === 'message02',
  )!;
  assert.equal((message.metadata as { createdBy: string }).createdBy, 'alice');
  assert.deepEqual(
    message.parts.find((part) => part.type === 'file'),
    file,
  );
});

test('a native pending queue can continue after the foreground tool is answered', async (t) => {
  const first = gate();
  t.after(first.release);
  let calls = 0;
  const { service, thread } = await fixture(t, async () => {
    if (++calls === 1) {
      await first.promise;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'question',
              toolName: 'ask_user',
              input: JSON.stringify({ question: 'Continue?' }),
            });
            controller.enqueue({
              type: 'finish',
              finishReason: 'tool-calls',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    }
    return reply(`answer-${calls}`);
  });
  await service.run('alice', thread.id, input('message01'));
  await until(() => calls === 1);
  await service.run('alice', thread.id, input('message02'));
  first.release();
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status ===
      'suspended',
  );
  const snapshot = await service.getThread('alice', thread.id);
  assert.equal(snapshot.thread.queueCount, 1);
  const interaction = snapshot.toolInteractions!.find(
    (item) => !item.response,
  )!;
  await service.respondToTool('alice', thread.id, interaction.id, {
    id: 'response1',
    action: 'resume',
    data: 'Yes',
  });
  await until(
    async () =>
      calls === 3 &&
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.queueCount,
    0,
  );
});

test('editing and sorting cancel native signals, preserve attachments and execute only the revised FIFO order', async (t) => {
  const first = gate();
  t.after(first.release);
  const prompts: string[] = [];
  const { service, thread, memory } = await fixture(t, async ({ prompt }) => {
    const call = prompts.push(JSON.stringify(prompt));
    if (call === 1) await first.promise;
    return reply(`reply-${call}`);
  });
  await service.run('alice', thread.id, input('message01'));
  await until(() => prompts.length === 1);
  const file = {
    type: 'file',
    mediaType: 'image/png',
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT5kAAAAASUVORK5CYII=',
  } as const;
  await service.run('alice', thread.id, {
    ...input('message02'),
    createdBy: 'alice',
    parts: [...input('message02').parts, file],
  });
  await service.run('alice', thread.id, input('message03'));
  await service.run('alice', thread.id, input('message04'));
  await assert.rejects(
    service.updateQueued('bob', thread.id, 'message02', { text: 'forbidden' }),
    { code: 'THREAD_NOT_FOUND' },
  );
  const app = createApp(
    {
      api: { getSession: async () => ({ user: { id: 'alice' } }) },
    } as unknown as Parameters<typeof createApp>[0],
    undefined,
    {
      threads: service,
      models: {} as LanguageModelService,
      webOrigin: 'http://localhost:5173',
    },
  );
  const request = (path: string, method: string, body?: object) =>
    app.request(`/api/threads/${thread.id}/queue${path}`, {
      method,
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal(
    (await request('/message02', 'PATCH', { parts: [] })).status,
    400,
  );
  assert.equal(
    (await request('/message02', 'PATCH', { text: 'Revised text' })).status,
    204,
  );
  const detail = await request('/message02', 'GET');
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).hasAttachments, true);
  assert.equal(
    (await request('', 'PATCH', { id: 'message04', beforeId: 'message02' }))
      .status,
    204,
  );
  assert.equal((await request('/message03', 'DELETE')).status, 204);
  const pending = await service.getThread('alice', thread.id);
  assert.deepEqual(
    pending.thread.queue?.map((item) => item.id),
    ['message04', 'message02'],
  );
  assert.equal(pending.thread.queueCount, 2);
  assert.equal(
    (await memory.getThreadById({ threadId: thread.id }))?.metadata?.queue,
    undefined,
  );
  first.release();
  await until(
    async () =>
      prompts.length === 3 &&
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.match(prompts[1], /message04/);
  assert.doesNotMatch(prompts[1], /Revised text|message02|message03/);
  assert.match(prompts[2], /Revised text/);
  assert.doesNotMatch(prompts[2], /message02|message03/);
  const history = await service.history('alice', thread.id);
  const users = history.messages.filter((message) => message.role === 'user');
  assert.deepEqual(
    users.map((message) => message.id),
    ['message01', 'message04', 'message02'],
  );
  const edited = users.find((message) => message.id === 'message02')!;
  assert.equal((edited.metadata as { createdBy: string }).createdBy, 'alice');
  assert.deepEqual(
    edited.parts.find((part) => part.type === 'file'),
    file,
  );
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.queue?.length,
    0,
  );
  await assert.rejects(
    service.updateQueued('alice', thread.id, 'message02', { text: 'too late' }),
    { code: 'QUEUED_MESSAGE_NOT_FOUND' },
  );
});
