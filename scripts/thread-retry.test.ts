import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;

test('retry uses existing native history, rejects outsiders and ignores concurrent clicks', async (t) => {
  const { memory, threads, messages } = fakeMemory();
  let retries = 0;
  let fail = true;
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return 'workspace';
    },
    async open({ onEvent }) {
      return sessionStub({
        async retry(selected) {
          assert.deepEqual(selected, settings);
          if (fail) throw new Error('Retry admission failed');
          retries++;
          onEvent({ type: 'status', status: 'running', runId: 'retry-run' });
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  Object.assign(threads.get(thread.id)!.metadata!, {
    status: 'failed',
    error: 'Provider unavailable',
  });
  await memory.saveMessages({
    messages: [
      {
        id: 'message01',
        threadId: thread.id,
        resourceId: 'user:alice',
        role: 'user',
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: 'text', text: 'Hello' }] },
      },
    ],
  });
  await assert.rejects(service.retry('bob', thread.id), {
    code: 'THREAD_NOT_FOUND',
  });
  await assert.rejects(
    service.retry('alice', thread.id),
    /Retry admission failed/,
  );
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.error,
    'Provider unavailable',
  );
  fail = false;
  await Promise.all([
    service.retry('alice', thread.id),
    service.retry('alice', thread.id),
  ]);
  await delay(0);
  assert.equal(retries, 1);
  assert.equal(messages.size, 1);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.error,
    null,
  );
});

test('a rejected tool resume leaves its interaction available for the same response', async (t) => {
  const { memory, threads } = fakeMemory();
  let calls = 0;
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return 'workspace';
    },
    async open({ onEvent }) {
      return sessionStub({
        async respond() {
          if (++calls === 1) throw new Error('Resume failed');
          onEvent({ type: 'status', status: 'success', runId: 'run1' });
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  Object.assign(threads.get(thread.id)!.metadata!, {
    status: 'suspended',
    toolInteractions: [
      {
        id: 'interaction1',
        kind: 'suspended',
        runId: 'run1',
        toolCallId: 'call1',
        toolName: 'ask_user',
        suspendPayload: { question: 'Continue?' },
        settings,
      },
    ],
  });
  const response = { id: 'response01', action: 'resume', data: 'Yes' } as const;
  await assert.rejects(
    service.respondToTool('alice', thread.id, 'interaction1', response),
    /Resume failed/,
  );
  assert.equal(
    (await service.getThread('alice', thread.id)).toolInteractions?.[0]
      .response,
    undefined,
  );
  await service.respondToTool('alice', thread.id, 'interaction1', response);
  await service.respondToTool('alice', thread.id, 'interaction1', response);
  assert.equal(calls, 2);
});
