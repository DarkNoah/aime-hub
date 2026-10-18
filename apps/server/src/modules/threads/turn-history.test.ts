import assert from 'node:assert/strict';
import test from 'node:test';
import { Memory } from '@mastra/memory';
import { InMemoryStore } from '@mastra/core/storage';
import {
  convertMessages,
  createSignal,
  type MastraDBMessage,
} from '@mastra/core/agent';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createChatStorage } from '../../mastra/storage.js';
import type { UIMessage } from 'ai';
import type { ChatTurnSnapshot } from '@aime/shared/chat-turns';
import { groupTurns, summarizeTurn } from './turns.js';
import { readTurnDetail, readTurnPage } from './turn-history.js';
import { ThreadService } from './service.js';
import { createApp } from '../../app.js';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const scope = { threadId: 'turntest00000001', resourceId: 'user:alice' };
const at = (offset: number) => new Date(Date.UTC(2026, 0, 1) + offset);

test('native queued inputs retain separate replies in summaries and lazy details', async (t) => {
  const root = await mkdtemp('/tmp/chat-turn-queue-');
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const mastra = new Mastra({
    storage,
    logger: false,
    backgroundTasks: { enabled: true },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => {
      const call = ++calls;
      if (call === 1) await gate;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'text' });
            controller.enqueue({
              type: 'text-delta',
              id: 'text',
              delta: `Answer ${call}`,
            });
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
    },
  });
  const runner = createChatRunner(
    mastra,
    {
      getLanguageModel: async () => ({
        model,
        reference: 'mock',
        maxOutputTokens: 111,
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
    release();
    await service.shutdown();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const settings = { model: null, reasoningEffort: 'auto' } as const;
  const thread = await service.createThread('alice', settings);
  const live = new Map<string, string | undefined>();
  const unsubscribe = await service.subscribe(
    'alice',
    thread.id,
    () => {},
    undefined,
    undefined,
    (snapshot) => {
      for (const turn of snapshot.turns) {
        const part = turn.assistant?.parts[0];
        live.set(turn.id, part?.type === 'text' ? part.text : undefined);
      }
    },
  );
  t.after(unsubscribe);
  for (let i = 1; i <= 3; i++)
    await service.run('alice', thread.id, {
      ...settings,
      id: `queued-input-${i}`,
      isImmediate: false,
      parts: [{ type: 'text', text: `Question ${i}` }],
    });
  release();
  for (let attempt = 0; attempt < 500; attempt++) {
    if (
      calls === 3 &&
      (await service.getThread('alice', thread.id)).thread.status ===
        'success' &&
      live.get('queued-input-3') === 'Answer 3'
    )
      break;
    await delay(10);
  }
  assert.equal(calls, 3);
  const page = await service.turnHistory('alice', thread.id);
  assert.equal(page.turns.length, 3);
  for (let i = 1; i <= 3; i++) {
    const turn = page.turns[i - 1];
    assert.equal(turn.id, `queued-input-${i}`);
    assert.deepEqual(turn.assistant?.parts, [
      { type: 'text', text: `Answer ${i}`, state: 'done' },
    ]);
    assert.equal(live.get(turn.id), `Answer ${i}`);
    const detail = await service.turnDetail(
      'alice',
      thread.id,
      turn.id,
      turn.cursor,
    );
    assert.deepEqual(
      detail.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.id),
      [turn.id],
    );
    assert.deepEqual(
      detail.messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'text')
        .map((part) => part.text),
      [`Answer ${i}`],
    );
  }
});

async function fixture() {
  const storage = new InMemoryStore();
  const memory = new Memory({
    storage,
    options: { generateTitle: false, semanticRecall: false },
  });
  await memory.createThread(scope);
  const store = (await storage.getStore('memory'))!;
  const save = async (messages: UIMessage[], time = 0) => {
    const rows = messages.flatMap((message, index) =>
      convertMessages([message])
        .to('Mastra.V2')
        .map((raw) => ({
          ...raw,
          ...scope,
          createdAt: at(time + index),
          content: JSON.parse(JSON.stringify(raw.content)),
        })),
    );
    await store.saveMessages({ messages: rows });
  };
  return { memory, store, save };
}

function user(id: string): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text: `Question ${id}` }],
  };
}
function reply(id: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      { type: 'text', text: 'intermediate' },
      { type: 'reasoning', text: 'private reasoning payload' },
      {
        type: 'tool-read_file',
        toolCallId: `${id}-tool`,
        state: 'output-available',
        input: { path: 'large.txt' },
        output: { text: 'hidden output '.repeat(1000) },
      },
      { type: 'text', text: `Answer ${id}` },
    ],
  };
}

test('summaries use the final nonblank text and distinct tools across all assistant messages', () => {
  const first = reply('a');
  const last = reply('b');
  last.parts.push(first.parts[2], { type: 'text', text: '  ' });
  const messages = [
    { ...user('u'), metadata: { createdAt: at(0).toISOString() } },
    first,
    {
      ...last,
      parts: last.parts.map((part) =>
        part.type === 'text'
          ? {
              ...part,
              providerMetadata: {
                mastra: { createdAt: at(65000).toISOString() },
              },
            }
          : part,
      ),
    },
  ];
  const summary = summarizeTurn(groupTurns(messages)[0]);
  assert.equal(summary.user?.id, 'u');
  assert.equal(summary.toolCount, 2);
  assert.equal(
    summary.assistant?.parts[0].type === 'text' &&
      summary.assistant.parts[0].text,
    'Answer b',
  );
  assert.equal(summary.elapsedMs, 65000);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /hidden output|private reasoning|intermediate/,
  );
  assert.ok(
    JSON.stringify(summary).length < JSON.stringify(messages).length / 10,
  );
});

test('turn pagination spans storage pages and does not shift when new messages arrive', async () => {
  const f = await fixture();
  for (let i = 0; i < 45; i++) {
    const assistants = Array.from({ length: i === 30 ? 125 : 2 }, (_, j) =>
      reply(`a-${i}-${j}`),
    );
    await f.save([user(`u-${i}`), ...assistants], i * 1000);
  }
  const first = await readTurnPage(f.memory, scope);
  assert.equal(groupTurns(first.messages).length, 20);
  assert.equal(first.messages[0].id, 'u-25');
  assert.ok(first.hasMore);
  await f.save([user('new'), reply('new-reply')], 100000);
  const second = await readTurnPage(f.memory, scope, first.cursor!);
  const third = await readTurnPage(f.memory, scope, second.cursor!);
  assert.deepEqual(
    [first, second, third].map((page) => groupTurns(page.messages).length),
    [20, 20, 5],
  );
  const ids = [first, second, third].flatMap((page) =>
    groupTurns(page.messages).map((turn) => turn.id),
  );
  assert.equal(new Set(ids).size, 45);
  assert.ok(!ids.includes('new'));
  assert.equal(third.cursor, null);
  const detail = await readTurnDetail(
    f.memory,
    scope,
    'u-30',
    first.locators.get('u-30')!,
  );
  assert.equal(detail.length, 126);
  assert.equal(detail.at(-1)?.id, 'a-30-124');
});

test('equal timestamps paginate by the actual stored boundary', async () => {
  const f = await fixture();
  const rows: MastraDBMessage[] = [];
  for (let i = 0; i < 45; i++) {
    const id = String(i).padStart(3, '0');
    rows.push({
      ...scope,
      id: `${id}-user`,
      role: 'user',
      createdAt: at(0),
      content: { format: 2, parts: [{ type: 'text', text: id }] },
    });
  }
  await f.store.saveMessages({ messages: rows });
  const first = await readTurnPage(f.memory, scope);
  const second = await readTurnPage(f.memory, scope, first.cursor!);
  const third = await readTurnPage(f.memory, scope, second.cursor!);
  assert.equal(
    new Set(
      [...first.messages, ...second.messages, ...third.messages].map(
        (message) => message.id,
      ),
    ).size,
    45,
  );
  await assert.rejects(
    readTurnPage(
      f.memory,
      { ...scope, threadId: 'another-thread' },
      first.cursor!,
    ),
    /VALIDATION_ERROR/,
  );
  await assert.rejects(
    readTurnDetail(
      f.memory,
      scope,
      'wrong-id',
      first.locators.get(first.messages[0].id)!,
    ),
    /TURN_NOT_FOUND/,
  );
});

test('native user signals keep their client identity and details omit the next turn', async () => {
  const f = await fixture();
  await f.store.saveMessages({
    messages: [
      createSignal({
        type: 'user',
        id: 'stored-user',
        contents: 'Hello',
        createdAt: at(0),
        metadata: { clientMessageId: 'client-user' },
      }).toDBMessage(scope),
      createSignal({
        type: 'reactive',
        id: 'reminder',
        contents: 'Internal reminder',
        createdAt: at(1),
      }).toDBMessage(scope),
    ],
  });
  await f.save([reply('a'), user('next-user')], 2);
  const page = await readTurnPage(f.memory, scope);
  assert.deepEqual(
    groupTurns(page.messages).map((turn) => turn.id),
    ['client-user', 'next-user'],
  );
  const detail = await readTurnDetail(
    f.memory,
    scope,
    'client-user',
    page.locators.get('client-user')!,
  );
  assert.deepEqual(
    detail.map((message) => message.id),
    ['client-user', 'a'],
  );
});

test('an assistant-only turn uses its own boundary after hidden system reminders', async () => {
  const f = await fixture();
  await f.store.saveMessages({
    messages: [
      createSignal({
        type: 'reactive',
        id: 'reminder',
        contents: 'Internal',
        createdAt: at(0),
      }).toDBMessage(scope),
    ],
  });
  await f.save([reply('assistant-only')], 1);
  const page = await readTurnPage(f.memory, scope);
  assert.equal(groupTurns(page.messages)[0].id, 'assistant-only');
  const detail = await readTurnDetail(
    f.memory,
    scope,
    'assistant-only',
    page.locators.get('assistant-only')!,
  );
  assert.deepEqual(
    detail.map((message) => message.id),
    ['assistant-only'],
  );
});

test(
  'PostgreSQL keeps complete turns and cursor boundaries at identical timestamps',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `turn_test_${randomBytes(6).toString('hex')}`;
    const { storage, memory } = createChatStorage(pool, schema);
    t.after(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    await storage.init();
    await memory.createThread(scope);
    const store = (await storage.getStore('memory'))!;
    for (let i = 0; i < 45; i++) {
      const prefix = String(i).padStart(3, '0');
      const signal = createSignal({
        type: 'user',
        id: `${prefix}-a`,
        contents: `Question ${i}`,
        createdAt: at(0),
        metadata: { clientMessageId: `user-${i}` },
      }).toDBMessage(scope);
      const answer = convertMessages([reply(`${prefix}-b`)]).to('Mastra.V2')[0];
      await store.saveMessages({
        messages: [
          signal,
          {
            ...answer,
            ...scope,
            createdAt: at(0),
            content: JSON.parse(JSON.stringify(answer.content)),
          },
        ],
      });
    }
    const first = await readTurnPage(memory, scope);
    const second = await readTurnPage(memory, scope, first.cursor!);
    const third = await readTurnPage(memory, scope, second.cursor!);
    assert.deepEqual(
      [first, second, third].map((page) => groupTurns(page.messages).length),
      [20, 20, 5],
    );
    const all = [third, second, first].flatMap((page) =>
      groupTurns(page.messages),
    );
    assert.equal(new Set(all.map((turn) => turn.id)).size, 45);
    for (const turn of all)
      assert.deepEqual(
        turn.messages.map((message) => message.role),
        ['user', 'assistant'],
      );
    const detail = await readTurnDetail(
      memory,
      scope,
      'user-30',
      first.locators.get('user-30')!,
    );
    assert.deepEqual(
      detail.map((message) => message.id),
      ['user-30', '030-b'],
    );
  },
);

test('summary subscriptions never send full assistant parts, and detail access stays authorized', async (t) => {
  const f = await fixture();
  await f.save([user('u'), reply('a')]);
  const service = new ThreadService(f.memory, {
    async validate() {},
    async createWorkspace() {
      return '/tmp/test-turns';
    },
    async open() {
      throw new Error('No model run expected');
    },
  });
  t.after(() => service.shutdown());
  const events: ChatTurnSnapshot[] = [];
  let historyReads = 0;
  const recall = f.memory.recall.bind(f.memory);
  t.mock.method(f.memory, 'recall', (args: Parameters<Memory['recall']>[0]) => {
    historyReads++;
    return recall(args);
  });
  await service.getThread('alice', scope.threadId);
  const unsubscribe = await service.subscribe(
    'alice',
    scope.threadId,
    () => assert.fail('Full snapshot leaked'),
    undefined,
    undefined,
    (snapshot) => events.push(snapshot),
  );
  t.after(unsubscribe);
  assert.equal(
    historyReads,
    1,
    'opening the summary stream reuses the initial storage read',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].turns.length, 1);
  assert.equal(events[0].history?.hasMore, false);
  assert.ok(!('messages' in events[0]));
  assert.doesNotMatch(
    JSON.stringify(events[0]),
    /hidden output|private reasoning/,
  );
  const detail = await service.turnDetail('alice', scope.threadId, 'u');
  assert.match(JSON.stringify(detail), /hidden output/);
  assert.equal(detail.revision, events[0].turns[0].revision);
  const updated = reply('a');
  updated.parts.push({
    type: 'text',
    text: 'Updated final answer after a late tool result',
  });
  await f.save([updated], 1);
  await service.refreshAutomationThread('alice', scope.threadId);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events.at(-1)?.turns.length, 1);
  assert.notEqual(events.at(-1)?.turns[0].revision, detail.revision);
  await service.refreshAutomationThread('alice', scope.threadId);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    events.at(-1)?.turns.length,
    0,
    'unchanged turns must not be retransmitted',
  );
  await assert.rejects(
    service.turnDetail('bob', scope.threadId, 'u'),
    /THREAD_NOT_FOUND/,
  );
  await assert.rejects(
    service.turnHistory('bob', scope.threadId),
    /THREAD_NOT_FOUND/,
  );
  const auth = {
    api: { getSession: async () => ({ user: { id: 'alice', role: 'user' } }) },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, {
    threads: service,
    models: {} as LanguageModelService,
    webOrigin: 'http://localhost:5173',
  });
  const response = await app.request(
    `/api/threads/${scope.threadId}/history?view=summary`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.turns[0].id, 'u');
  assert.ok(!('messages' in body));
  assert.equal(
    (await app.request(`/api/threads/${scope.threadId}/turns/u`)).status,
    200,
  );
  const abort = new AbortController();
  const stream = await app.request(
    `/api/threads/${scope.threadId}/messages?view=summary`,
    { signal: abort.signal },
  );
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  t.after(async () => {
    abort.abort();
    await reader.cancel();
  });
  let chunk = '';
  while (!chunk.includes('event: snapshot'))
    chunk += new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /event: snapshot/);
  assert.match(chunk, /"turns":/);
  assert.doesNotMatch(chunk, /hidden output|private reasoning|"messages":/);
  abort.abort();
  await reader.cancel();
});
