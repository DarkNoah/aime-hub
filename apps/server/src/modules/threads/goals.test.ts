import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore, type GoalObjectiveRecord } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { runInputSchema } from '@aime/shared/threads';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';
import { createApp } from '../../app.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = (goal = true) => ({
  ...settings,
  id: 'goal-message-01',
  isImmediate: false,
  goal,
  parts: [{ type: 'text' as const, text: 'Finish the test objective' }],
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Goal state did not settle');
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
  respond: (judge: boolean, prompt: string) => Promise<string>,
) {
  const root = await mkdtemp('/tmp/thread-goals-');
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const mastra = new Mastra({ storage, logger: false });
  const model = new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }) => {
      const serialized = JSON.stringify(prompt);
      const text = await respond(
        serialized.includes('You are the goal judge.'),
        serialized,
      );
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'text-start', id: 'answer' });
            c.enqueue({ type: 'text-delta', id: 'answer', delta: text });
            c.enqueue({ type: 'text-end', id: 'answer' });
            c.enqueue({
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            c.close();
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
        supportsImages: true,
        toolCall: false,
      }),
    } as unknown as LanguageModelService,
    root,
  );
  const service = new ThreadService(memory, runner);
  t.after(async () => {
    await service.shutdown();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const thread = await service.createThread('alice', settings);
  return { service, thread, storage, runner, memory };
}
const decision = (value: 'done' | 'continue' | 'waiting') =>
  JSON.stringify({ decision: value, reason: `Judge says ${value}` });

test('ordinary messages never invoke a goal judge', async (t) => {
  let calls = 0;
  const { service, thread } = await fixture(t, async (judge) => {
    assert.equal(judge, false);
    calls++;
    return 'Done';
  });
  await service.run('alice', thread.id, input(false));
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.equal(calls, 1);
  assert.equal((await service.getThread('alice', thread.id)).goal, null);
});

test('native judge continues then completes, streams progress and persists across service reload', async (t) => {
  let judges = 0;
  let answers = 0;
  const { service, thread, runner, memory } = await fixture(
    t,
    async (judge, prompt) => {
      if (judge) return decision(++judges === 1 ? 'continue' : 'done');
      assert.match(prompt, /current-objective/);
      answers++;
      return `Attempt ${answers}`;
    },
  );
  const seen: string[] = [];
  const unsubscribe = await service.subscribe(
    'alice',
    thread.id,
    (snapshot) => {
      if (snapshot.goal) seen.push(snapshot.goal.status);
    },
  );
  t.after(unsubscribe);
  await service.run('alice', thread.id, input());
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).goal?.status === 'done',
  );
  const goal = (await service.getThread('alice', thread.id)).goal;
  assert.equal(goal?.runsUsed, 2);
  assert.equal(goal?.maxRuns, 50);
  assert.equal(answers, 2);
  assert.ok(seen.includes('active'));
  await service.run('alice', thread.id, input());
  assert.equal((await runner.getGoal!(thread.id))?.runsUsed, 2);
  await service.shutdown();
  const restored = new ThreadService(memory, runner);
  t.after(() => restored.shutdown());
  assert.equal(
    (await restored.getThread('alice', thread.id)).goal?.status,
    'done',
  );
  await assert.rejects(restored.clearGoal('bob', thread.id), {
    code: 'THREAD_NOT_FOUND',
  });
  await restored.clearGoal('alice', thread.id);
  assert.equal(await runner.getGoal!(thread.id), null);
});

test('closing during a judge evaluation cannot resurrect the objective', async (t) => {
  const judging = gate();
  t.after(judging.release);
  let entered = false;
  const { service, thread, runner } = await fixture(t, async (judge) => {
    if (!judge) return 'Attempt';
    entered = true;
    await judging.promise;
    return decision('continue');
  });
  await service.run('alice', thread.id, input());
  await until(() => entered);
  const closing = service.clearGoal('alice', thread.id);
  await delay(20);
  judging.release();
  await closing;
  await delay(50);
  assert.equal(await runner.getGoal!(thread.id), null);
  assert.equal((await service.getThread('alice', thread.id)).goal, null);
});

test('budget exhaustion pauses the durable goal instead of resetting it', async (t) => {
  const answering = gate();
  t.after(answering.release);
  const { service, thread, storage } = await fixture(t, async (judge) => {
    if (judge) return decision('continue');
    await answering.promise;
    return 'Incomplete';
  });
  await service.run('alice', thread.id, input());
  const store = (await storage.getStore('threadState'))!;
  const record = (await store.getState<GoalObjectiveRecord>({
    threadId: thread.id,
    type: 'goal',
  }))!;
  await store.setState({
    threadId: thread.id,
    type: 'goal',
    value: { ...record, maxRuns: 1 },
  });
  answering.release();
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).goal?.status === 'paused',
  );
  const goal = (await service.getThread('alice', thread.id)).goal;
  assert.equal(goal?.runsUsed, 1);
  assert.match(goal?.pausedReason ?? '', /budget/);
});

test('a goal requires text while ordinary image messages remain valid', () => {
  const parts = [
    { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,YQ==' },
  ];
  assert.equal(runInputSchema.safeParse({ ...input(), parts }).success, false);
  assert.equal(
    runInputSchema.safeParse({ ...input(false), parts }).success,
    true,
  );
});

test('waiting for the user is displayed after the turn and follow-up keeps the original objective', async (t) => {
  let judges = 0;
  const { service, thread } = await fixture(t, async (judge) =>
    judge ? decision(++judges === 1 ? 'waiting' : 'done') : 'Answer',
  );
  await service.run('alice', thread.id, input());
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  await delay(60);
  const waiting = (await service.getThread('alice', thread.id)).goal;
  assert.equal(waiting?.waitingForUser, true);
  assert.equal(waiting?.status, 'active');
  await service.run('alice', thread.id, {
    ...input(),
    id: 'goal-message-02',
    parts: [{ type: 'text', text: 'Approved, continue' }],
  });
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).goal?.status === 'done',
  );
  const completed = (await service.getThread('alice', thread.id)).goal;
  assert.equal(completed?.objective, input().parts[0].text);
  assert.equal(completed?.runsUsed, 2);
});

test('goal endpoint requires authentication, same origin and thread access', async (t) => {
  const { service, thread } = await fixture(t, async () => 'Done');
  let userId: string | undefined;
  const auth = {
    api: { getSession: async () => (userId ? { user: { id: userId } } : null) },
  } as unknown as Parameters<typeof createApp>[0];
  const origin = 'http://localhost:5173';
  const app = createApp(auth, undefined, {
    threads: service,
    models: {} as LanguageModelService,
    webOrigin: origin,
  });
  const clear = (requestOrigin = origin) =>
    app.request(`/api/threads/${thread.id}/goal`, {
      method: 'DELETE',
      headers: { origin: requestOrigin },
    });
  assert.equal((await clear()).status, 401);
  userId = 'bob';
  assert.equal((await clear()).status, 404);
  userId = 'alice';
  assert.equal((await clear('https://other.example')).status, 403);
  assert.equal((await clear()).status, 204);
});

test('clearing a completed goal does not interrupt a later ordinary reply', async (t) => {
  const reply = gate();
  t.after(reply.release);
  let answers = 0;
  const { service, thread } = await fixture(t, async (judge) => {
    if (judge) return decision('done');
    if (++answers === 2) await reply.promise;
    return 'Answer';
  });
  await service.run('alice', thread.id, input());
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).goal?.status === 'done',
  );
  await service.run('alice', thread.id, {
    ...input(false),
    id: 'ordinary-message02',
  });
  await until(() => answers === 2);
  await service.clearGoal('alice', thread.id);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.status,
    'running',
  );
  reply.release();
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.equal((await service.getThread('alice', thread.id)).goal, null);
});

test('new goals enter an already running thread immediately', async (t) => {
  const reply = gate();
  t.after(reply.release);
  let answers = 0;
  let sawObjective = false;
  const { service, thread } = await fixture(t, async (judge, prompt) => {
    if (judge) return decision(sawObjective ? 'done' : 'continue');
    if (++answers === 1) await reply.promise;
    else sawObjective ||= prompt.includes('Finish the test objective');
    return 'Answer';
  });
  await service.run('alice', thread.id, {
    ...input(false),
    id: 'ordinary-message01',
    parts: [{ type: 'text', text: 'Initial task' }],
  });
  await until(() => answers === 1);
  await service.run('alice', thread.id, input());
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.queue?.[0]
      ?.isImmediate,
    true,
  );
  reply.release();
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).goal?.status === 'done',
  );
  assert.equal(sawObjective, true);
});
