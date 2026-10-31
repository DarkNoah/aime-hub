import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fakeMemory } from '../../../../../scripts/fixtures/thread-memory.js';
import { sessionStub } from '../../../../../scripts/fixtures/thread-session.js';
import { ThreadService, type ChatRunner } from '../threads/service.js';
import type {
  ChatSessionContext,
  IssueThreadObservation,
} from '../threads/session.js';

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('Issue observation did not settle');
}

test('Issue completion outbox survives observer failure/restart and interrupted runs report an error without rerunning', async (t) => {
  const { memory, threads: stored } = fakeMemory();
  let session!: ChatSessionContext;
  let modelSessions = 0;
  const runner: ChatRunner = {
    async createWorkspace() {
      return '/tmp/issue-event-fixture';
    },
    async validate() {},
    async open(context) {
      session = context;
      modelSessions++;
      return sessionStub();
    },
  };
  const first = new ThreadService(memory, runner);
  const settings = { model: null, reasoningEffort: 'auto' } as const;
  const thread = await first.createIssueThread(
    'alice',
    { ...settings, title: 'Task' },
    42,
  );
  first.setIssueObserver(async (_id, _status, event) => {
    if (event) throw new Error('Database temporarily unavailable');
  });
  await first.run('alice', thread.id, {
    ...settings,
    id: 'input00000000001',
    parts: [{ type: 'text', text: 'Do task' }],
    isImmediate: false,
  });
  session.onEvent({ type: 'status', status: 'running', runId: 'run-1' });
  session.onEvent({
    type: 'message',
    active: true,
    message: {
      id: 'result-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Verified result' }],
    },
  });
  session.onEvent({ type: 'status', status: 'success', runId: 'run-1' });
  await until(
    () =>
      (stored.get(thread.id)?.metadata?.issueEvents as unknown[])?.length === 1,
  );
  await first.shutdown();
  const recovered = new ThreadService(memory, runner);
  t.after(() => recovered.shutdown());
  const events: IssueThreadObservation[] = [];
  recovered.setIssueObserver(async (_id, _status, event) => {
    if (event) events.push(event);
  });
  await recovered.recoverIssueThread('alice', thread.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.runId, 'run-1');
  assert.equal(events[0]?.result, 'Verified result');
  assert.deepEqual(stored.get(thread.id)?.metadata?.issueEvents, []);
  await recovered.recoverIssueThread('alice', thread.id);
  assert.equal(events.length, 1);
  assert.equal(modelSessions, 1, 'Recovery must not open a model session');
  const interrupted = await recovered.createIssueThread(
    'alice',
    { ...settings, title: 'Interrupted' },
    43,
  );
  await memory.updateThread({
    id: interrupted.id,
    title: 'Interrupted',
    metadata: {
      status: 'running',
      activeId: 'run-2',
      issueExecution: { runId: 'run-2', result: '' },
      issueStatus: 'run-2:running',
    },
  });
  await recovered.recoverIssueThread('alice', interrupted.id);
  assert.equal(events.at(-1)?.status, 'failed');
  assert.equal(events.at(-1)?.error, 'RUN_INTERRUPTED');
  assert.equal(modelSessions, 1);
  const pending = await recovered.createIssueThread(
    'alice',
    { ...settings, title: 'Pending' },
    44,
  );
  await memory.updateThread({
    id: pending.id,
    title: 'Pending',
    metadata: {
      status: 'pending',
      activeId: null,
      issueExecution: { runId: 'input-before-run', result: '' },
      issueStatus: 'input-before-run:pending',
    },
  });
  await recovered.recoverIssueThread('alice', pending.id);
  assert.equal(events.at(-1)?.runId, 'input-before-run');
  assert.equal(events.at(-1)?.error, 'RUN_INTERRUPTED');
});
