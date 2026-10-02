import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import {
  discoverPersonalSkills,
  userDirectory,
} from '../apps/server/src/modules/threads/workspace.js';
import { getProviderOptions } from '../apps/server/src/modules/models/language-model.js';
import { runInputSchema, type RunInput } from '@aime/shared/threads';
import { mergeMessages } from '../apps/web/src/components/chat/messages.js';
import { createThreadListResource } from '../apps/web/src/pages/threads/list-resource.js';
import type { ThreadList, ThreadSummary } from '@aime/shared/threads';

type Memory = ConstructorParameters<typeof ThreadService>[0];
type Thread = NonNullable<Awaited<ReturnType<Memory['getThreadById']>>>;
type StoredMessage = Parameters<Memory['saveMessages']>[0]['messages'][number];

function fakeMemory() {
  const threads = new Map<string, Thread>();
  const messages = new Map<string, StoredMessage>();
  const memory: Memory = {
    async createThread({ threadId, resourceId, title, metadata }) {
      const thread = {
        id: threadId!,
        resourceId,
        title,
        metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      threads.set(thread.id, structuredClone(thread));
      return structuredClone(thread);
    },
    async getThreadById({ threadId }) {
      return structuredClone(threads.get(threadId) ?? null);
    },
    async updateThread({ id, title, metadata }) {
      const thread = {
        ...threads.get(id)!,
        title,
        metadata: { ...threads.get(id)!.metadata, ...metadata },
        updatedAt: new Date(),
      };
      threads.set(id, structuredClone(thread));
      return structuredClone(thread);
    },
    async listThreads({ filter, page = 0, perPage = 30 }) {
      const all = [...threads.values()].filter(
        (thread) => thread.resourceId === filter?.resourceId,
      );
      const size = perPage || all.length;
      return {
        threads: all.slice(page * size, (page + 1) * size),
        page,
        perPage,
        total: all.length,
        hasMore: (page + 1) * size < all.length,
      };
    },
    async recall({ threadId, page = 0, perPage = 40, filter }) {
      const all = [...messages.values()]
        .filter(
          (message) =>
            message.threadId === threadId &&
            (!filter?.dateRange?.end ||
              message.createdAt <= filter.dateRange.end),
        )
        .sort((a, b) => +b.createdAt - +a.createdAt);
      const size = perPage || all.length;
      return {
        messages: all.slice(page * size, (page + 1) * size),
        page,
        perPage,
        total: all.length,
        hasMore: (page + 1) * size < all.length,
      };
    },
    async saveMessages({ messages: input }) {
      input.forEach((message) => messages.set(message.id, message));
      return { messages: input };
    },
    async deleteThread(id) {
      threads.delete(id);
      for (const [key, message] of messages)
        if (message.threadId === id) messages.delete(key);
    },
  };
  return { memory, threads, messages };
}
const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = (id: string, isImmediate = false): RunInput => ({
  ...settings,
  id,
  isImmediate,
  parts: [{ type: 'text', text: id }],
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let count = 0; count < 200; count++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for expected thread state');
}
const baseRunner = {
  async validate() {},
  async createWorkspace() {
    return '/workspace/user/date-test';
  },
};

test('personal ownership is enforced for every thread operation', async (t) => {
  const { memory } = fakeMemory();
  const service = new ThreadService(memory, {
    ...baseRunner,
    async execute() {},
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  for (const operation of [
    () => service.getThread('bob', thread.id),
    () => service.history('bob', thread.id),
    () => service.run('bob', thread.id, input('message01')),
    () => service.abort('bob', thread.id),
    () => service.resume('bob', thread.id),
    () => service.cancelQueued('bob', thread.id, 'message01'),
    () => service.updateThread('bob', thread.id, { title: 'stolen' }),
    () => service.deleteThread('bob', thread.id),
    () => service.subscribe('bob', thread.id, () => {}),
  ])
    await assert.rejects(
      operation,
      (error) =>
        error instanceof ThreadError && error.code === 'THREAD_NOT_FOUND',
    );
  assert.equal((await service.listThreads('bob')).threads.length, 0);
});

test('thread lists paginate ten records at a time without crossing ownership', async (t) => {
  const { memory } = fakeMemory();
  const service = new ThreadService(memory, {
    ...baseRunner,
    async execute() {},
  });
  t.after(() => service.shutdown());
  for (let i = 0; i < 23; i++) await service.createThread('alice', settings);
  await service.createThread('bob', settings);
  const pages = await Promise.all(
    [0, 1, 2].map((page) => service.listThreads('alice', page)),
  );
  assert.deepEqual(
    pages.map((page) => page.threads.length),
    [10, 10, 3],
  );
  assert.deepEqual(
    pages.map((page) => page.hasMore),
    [true, true, false],
  );
  assert.equal(
    new Set(pages.flatMap((page) => page.threads.map((thread) => thread.id)))
      .size,
    23,
  );
});

test('sidebar paging shares requests and preserves live edits and deletions during loading', async () => {
  const thread = (id: string): ThreadSummary => ({
    ...settings,
    id,
    title: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'idle',
    queue: [],
    error: null,
  });
  const requested: number[] = [];
  let resolvePage!: (value: ThreadList) => void;
  const resource = createThreadListResource(async (page = 0) => {
    requested.push(page);
    return new Promise((resolve) => {
      resolvePage = resolve;
    });
  });
  const first = resource.loadMore();
  assert.equal(resource.loadMore(), first);
  resource.update({ ...thread('a'), title: 'Renamed while loading' });
  resource.remove('b');
  resolvePage({
    threads: [thread('a'), thread('b'), thread('c')],
    page: 0,
    hasMore: true,
  });
  await first;
  assert.deepEqual(
    resource.getSnapshot().threads.map((item) => item.title),
    ['Renamed while loading', 'c'],
  );
  const next = resource.loadMore();
  resolvePage({ threads: [thread('c'), thread('d')], page: 1, hasMore: false });
  await next;
  await resource.loadMore();
  assert.deepEqual(requested, [0, 1]);
  assert.deepEqual(
    resource.getSnapshot().threads.map((item) => item.id),
    ['a', 'c', 'd'],
  );
});

test('sidebar retries the failed page and ignores a cancelled request', async () => {
  const requested: number[] = [];
  let resolveCancelled!: (value: ThreadList) => void;
  const resource = createThreadListResource(async (page = 0) => {
    requested.push(page);
    if (requested.length === 1)
      return new Promise((resolve) => {
        resolveCancelled = resolve;
      });
    if (requested.length === 2) throw new TypeError('Offline');
    return { threads: [], page, hasMore: false };
  });
  const cancelled = resource.loadMore();
  resource.cancel();
  await resource.loadMore();
  resolveCancelled({ threads: [], page: 9, hasMore: false });
  await cancelled;
  assert.equal(resource.getSnapshot().page, -1);
  assert.equal(resource.getSnapshot().error, 'errors.network');
  await resource.loadMore();
  assert.deepEqual(requested, [0, 0, 0]);
  assert.equal(resource.getSnapshot().error, null);
  assert.equal(resource.getSnapshot().page, 0);
});

test('idle submissions run directly without appearing in persisted or published queues', async (t) => {
  const { memory, messages } = fakeMemory();
  const persistedQueues: string[][] = [];
  const publishedQueues: string[][] = [];
  const updateThread = memory.updateThread.bind(memory);
  memory.updateThread = async (args) => {
    const data = args.metadata as { queue: RunInput[] };
    persistedQueues.push(data.queue.map((item) => item.id));
    return updateThread(args);
  };
  const started: string[] = [];
  const service = new ThreadService(memory, {
    ...baseRunner,
    async execute({ input, signal }) {
      assert.ok(messages.has(input.id));
      started.push(input.id);
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.subscribe('alice', thread.id, (snapshot) => {
    publishedQueues.push(snapshot.thread.queue.map((item) => item.id));
  });
  for (const isImmediate of [false, true]) {
    const message = input(isImmediate ? 'message02' : 'message01', isImmediate);
    const accepted = await service.run('alice', thread.id, message);
    assert.equal(accepted.status, 'running');
    assert.deepEqual(accepted.queue, []);
    assert.ok(messages.has(message.id));
    await until(() => started.includes(message.id));
    await service.run('alice', thread.id, message);
    assert.equal(started.filter((id) => id === message.id).length, 1);
    await service.abort('alice', thread.id);
    await until(
      async () =>
        (await service.getThread('alice', thread.id)).thread.status === 'idle',
    );
  }
  assert.ok(persistedQueues.length > 0);
  assert.ok(publishedQueues.length > 0);
  assert.ok(persistedQueues.every((queue) => queue.length === 0));
  assert.ok(publishedQueues.every((queue) => queue.length === 0));
});

test('failed direct admission can be retried without losing or duplicating the message', async (t) => {
  const { memory } = fakeMemory();
  const started: string[] = [];
  const service = new ThreadService(memory, {
    ...baseRunner,
    async execute({ input }) {
      started.push(input.id);
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  const saveMessages = memory.saveMessages.bind(memory);
  memory.saveMessages = async () => {
    throw new Error('Message storage unavailable');
  };
  await assert.rejects(service.run('alice', thread.id, input('message01')));
  assert.deepEqual(started, []);
  assert.deepEqual((await service.getThread('alice', thread.id)).messages, []);
  memory.saveMessages = saveMessages;
  const updateThread = memory.updateThread.bind(memory);
  memory.updateThread = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(service.run('alice', thread.id, input('message01')));
  assert.deepEqual(started, []);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.status,
    'idle',
  );
  memory.updateThread = updateThread;
  const accepted = await service.run('alice', thread.id, input('message01'));
  assert.deepEqual(accepted.queue, []);
  await until(() => started.length === 1);
  assert.deepEqual(started, ['message01']);
});

test('disconnect never aborts a run; concurrent submissions serialize and retries are idempotent', async (t) => {
  const { memory } = fakeMemory();
  let active = 0;
  let maximum = 0;
  const started: string[] = [];
  const gates: Array<() => void> = [];
  const service = new ThreadService(memory, {
    ...baseRunner,
    async execute({ input, onMessage }) {
      active++;
      maximum = Math.max(maximum, active);
      started.push(input.id);
      await new Promise<void>((resolve) => gates.push(resolve));
      onMessage({
        id: `reply-${input.id}`,
        role: 'assistant',
        parts: [{ type: 'text', text: input.id }],
      });
      active--;
    },
  });
  t.after(async () => {
    gates.forEach((resolve) => resolve());
    await service.shutdown();
  });
  const thread = await service.createThread('alice', settings);
  let updates = 0;
  const unsubscribe = await service.subscribe(
    'alice',
    thread.id,
    () => updates++,
  );
  await service.run('alice', thread.id, input('message01'));
  await until(() => started.length === 1);
  unsubscribe();
  const previousUpdates = updates;
  await Promise.all([
    service.run('alice', thread.id, input('message02')),
    service.run('alice', thread.id, input('message03')),
    service.run('alice', thread.id, input('message02')),
  ]);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.queue.length,
    2,
  );
  gates.shift()!();
  await until(() => started.length === 2);
  gates.shift()!();
  await until(() => started.length === 3);
  gates.shift()!();
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status === 'idle',
  );
  assert.equal(maximum, 1);
  assert.deepEqual(started, ['message01', 'message02', 'message03']);
  assert.equal(updates, previousUpdates);
  const snapshot = await service.getThread('alice', thread.id);
  assert.equal(
    snapshot.messages.filter((message) => message.role === 'assistant').length,
    3,
  );
});

test('immediate input joins at a step boundary while normal messages stay queued; stop pauses the queue', async (t) => {
  const { memory } = fakeMemory();
  let context: Parameters<ChatRunner['execute']>[0] | undefined;
  let executions = 0;
  const service = new ThreadService(memory, {
    ...baseRunner,
    async execute(value) {
      context = value;
      executions++;
      await new Promise<void>((resolve) => {
        if (value.signal.aborted) resolve();
        else
          value.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input('message01'));
  await until(() => !!context);
  await service.run('alice', thread.id, input('message02'));
  await service.run('alice', thread.id, input('message03', true));
  assert.deepEqual(
    (await context!.takeImmediate()).map((message) => message.id),
    ['message03'],
  );
  assert.deepEqual(
    (await service.getThread('alice', thread.id)).thread.queue.map(
      (message) => message.id,
    ),
    ['message02'],
  );
  await service.abort('alice', thread.id);
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status === 'idle',
  );
  assert.equal(executions, 1);
  await service.resume('alice', thread.id);
  await until(() => executions === 2);
});

test('restart marks unfinished work interrupted and retains queued messages for explicit resume', async (t) => {
  const { memory, threads } = fakeMemory();
  let runs = 0;
  const service = new ThreadService(memory, {
    ...baseRunner,
    async execute() {
      runs++;
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  const stored = threads.get(thread.id)!;
  stored.metadata = {
    ...stored.metadata,
    activeId: 'previous-run',
    queue: [{ ...input('message02'), createdAt: new Date().toISOString() }],
  };
  const snapshot = await service.getThread('alice', thread.id);
  assert.equal(snapshot.thread.error, 'RUN_INTERRUPTED');
  assert.equal(snapshot.thread.queue.length, 1);
  assert.equal(runs, 0);
  await service.resume('alice', thread.id);
  await until(() => runs === 1);
});

test('fixed history pagination does not shift when new messages arrive, even with equal timestamps', async (t) => {
  const { memory, messages } = fakeMemory();
  const service = new ThreadService(memory, {
    ...baseRunner,
    async execute() {},
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  for (let i = 0; i < 65; i++)
    messages.set(`msg-${i}`, {
      id: `msg-${i}`,
      role: 'user',
      threadId: thread.id,
      resourceId: 'user:alice',
      createdAt: new Date('2026-01-01'),
      content: { format: 2, parts: [{ type: 'text', text: String(i) }] },
    });
  const first = await service.history(
    'alice',
    thread.id,
    0,
    '2026-01-02T00:00:00.000Z',
  );
  messages.set('new-message', {
    id: 'new-message',
    role: 'user',
    threadId: thread.id,
    resourceId: 'user:alice',
    createdAt: new Date('2026-01-03'),
    content: { format: 2, parts: [{ type: 'text', text: 'new' }] },
  });
  const second = await service.history('alice', thread.id, 1, first.anchor);
  assert.equal(first.messages.length, 40);
  assert.equal(second.messages.length, 25);
  assert.equal(
    new Set(
      [...first.messages, ...second.messages].map((message) => message.id),
    ).size,
    65,
  );
});

test('message validation rejects remote file URLs and unsupported roles; history merge preserves streamed text', () => {
  assert.equal(
    runInputSchema.safeParse({
      ...input('message01'),
      parts: [
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'http://127.0.0.1/private',
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    runInputSchema.safeParse({ ...input('message01'), resourceId: 'user:bob' })
      .success,
    false,
  );
  const live = {
    id: 'reply1',
    role: 'assistant' as const,
    parts: [{ type: 'text' as const, text: 'complete reply' }],
  };
  const old = { ...live, parts: [{ type: 'text' as const, text: 'partial' }] };
  assert.deepEqual(mergeMessages([live], [old], true), [live]);
  assert.deepEqual(mergeMessages([old], [live]), [live]);
  assert.deepEqual(
    getProviderOptions({ reasoningEffort: 'high', reasoning: false }),
    {},
  );
  assert.equal(
    getProviderOptions({ reasoningEffort: 'auto', thinkingMode: 'none' }).openai
      ?.reasoningEffort,
    'none',
  );
});

test('nested skills group by relative folder and personal IDs override global IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aime-skills-'));
  try {
    for (const path of [
      '.agents/skills/owner/repo/review',
      '.agents/skills/owner/repo/search',
      '.agents/skills/writer',
      'users/alice/.agents/skills/team/review',
    ]) {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(
        join(root, path, 'SKILL.md'),
        '---\nname: test\n---\nTest',
      );
    }
    const skills = await discoverPersonalSkills(root, 'alice');
    assert.equal(skills.length, 3);
    assert.equal(skills.find((skill) => skill.id === 'review')?.group, 'team');
    assert.equal(
      skills.find((skill) => skill.id === 'review')?.path,
      join(root, 'users/alice/.agents/skills/team/review'),
    );
    assert.equal(
      skills.find((skill) => skill.id === 'search')?.group,
      'owner/repo',
    );
    assert.equal(skills.find((skill) => skill.id === 'writer')?.group, '');
    assert.throws(() => userDirectory(root, '../bob'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
