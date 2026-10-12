import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunInput, ThreadNavigationEvent } from '@aime/shared/threads';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const input: RunInput = {
  ...settings,
  id: 'message01',
  isImmediate: false,
  parts: [{ type: 'text', text: 'Explain asynchronous title generation' }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('Thread title did not settle');
}
function fixture(t: TestContext) {
  const { memory, threads } = fakeMemory();
  const title = deferred<string | undefined>();
  const calls: RunInput[] = [];
  let rejectSend = false;
  const service = new ThreadService(
    memory,
    {
      async validate() {},
      async createWorkspace() {
        return 'workspace';
      },
      async open({ onEvent }) {
        return sessionStub({
          async send(message) {
            if (rejectSend) throw new Error('Submission failed');
            onEvent({ type: 'status', status: 'running', runId: message.id });
            onEvent({ type: 'status', status: 'success', runId: message.id });
          },
          async generateTitle(message) {
            calls.push(message);
            return title.promise;
          },
        });
      },
    },
    {
      async assertMember() {
        return { role: 'owner' };
      },
      async list() {
        return { projects: [], hasMore: false, page: 0 };
      },
    },
  );
  t.after(async () => {
    title.resolve(undefined);
    await service.shutdown();
  });
  return {
    service,
    memory,
    threads,
    calls,
    title,
    failSubmission(value: boolean) {
      rejectSend = value;
    },
  };
}

for (const projectId of [undefined, 'project123456789']) {
  test(
    `first title runs once without blocking replies and publishes to subscribers (${projectId ?? 'personal'})`,
    { timeout: 5000 },
    async (t) => {
      const { service, threads, title, calls } = fixture(t);
      const thread = await service.createThread('alice', {
        ...settings,
        projectId,
      });
      const snapshots: string[] = [];
      await service.subscribe('alice', thread.id, (snapshot) =>
        snapshots.push(snapshot.thread.title),
      );
      const events: ThreadNavigationEvent[] = [];
      service.subscribeNavigation(
        'alice',
        (event) => events.push(event),
        () => {},
      );
      await until(() => events.length > 0);
      const submitted = await service.run('alice', thread.id, input);
      assert.equal(submitted.title, 'Explain asynchronous title generation');
      await until(() => threads.get(thread.id)?.metadata?.status === 'success');
      await service.run('alice', thread.id, input);
      await service.run('alice', thread.id, { ...input, id: 'message02' });
      assert.deepEqual(calls, [input]);

      title.resolve('  Async\nTitle Generation  ');
      await until(() => snapshots.includes('Async Title Generation'));
      await until(() =>
        events.some(
          (event) =>
            event.type === 'upsert' &&
            event.thread.title === 'Async Title Generation',
        ),
      );
      assert.equal(threads.get(thread.id)?.title, 'Async Title Generation');
      assert.equal(threads.get(thread.id)?.metadata?.autoTitle, false);
      await service.shutdown();
      assert.equal(
        (await service.listThreads('alice', 0, projectId)).threads[0].title,
        'Async Title Generation',
      );
    },
  );
}

test('explicit titles skip generation and manual edits win even when equal to the fallback', async (t) => {
  const { service, threads, title, calls } = fixture(t);
  const named = await service.createThread('alice', {
    ...settings,
    title: 'My title',
  });
  await service.run('alice', named.id, input);
  assert.equal(calls.length, 0);
  assert.equal(threads.get(named.id)?.title, 'My title');

  const thread = await service.createThread('alice', settings);
  const first = await service.run('alice', thread.id, input);
  await service.updateThread('alice', thread.id, { title: first.title });
  title.resolve('Generated title');
  await delay(0);
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.title,
    first.title,
  );
});

for (const outcome of ['reject', 'empty', 'undefined', 'save-error'] as const) {
  test(`title ${outcome} keeps the fallback and successful chat status`, async (t) => {
    const { service, memory, threads, title, calls } = fixture(t);
    const errors = t.mock.method(console, 'error', () => {});
    const thread = await service.createThread('alice', settings);
    const first = await service.run('alice', thread.id, input);
    await until(() => threads.get(thread.id)?.metadata?.status === 'success');
    if (outcome === 'save-error') {
      const update = memory.updateThread.bind(memory);
      t.mock.method(
        memory,
        'updateThread',
        async (args: Parameters<typeof update>[0]) => {
          if (args.title === 'Generated title') throw new Error('Save failed');
          return update(args);
        },
      );
    }
    if (outcome === 'reject') title.reject(new Error('Title model failed'));
    else
      title.resolve(
        outcome === 'empty'
          ? ' \n '
          : outcome === 'save-error'
            ? 'Generated title'
            : undefined,
      );
    await delay(0);
    const snapshot = await service.getThread('alice', thread.id);
    assert.equal(snapshot.thread.title, first.title);
    assert.equal(snapshot.thread.status, 'success');
    assert.equal(snapshot.thread.error, null);
    assert.equal(threads.get(thread.id)?.title, first.title);
    assert.equal(
      errors.mock.callCount(),
      outcome === 'reject' || outcome === 'save-error' ? 1 : 0,
    );
    await service.run('alice', thread.id, { ...input, id: 'message02' });
    assert.equal(calls.length, 1);
  });
}

test('rejected submissions do not consume first-message title generation', async (t) => {
  const { service, title, calls, failSubmission } = fixture(t);
  const thread = await service.createThread('alice', settings);
  failSubmission(true);
  await assert.rejects(
    service.run('alice', thread.id, input),
    /Submission failed/,
  );
  assert.equal(calls.length, 0);
  failSubmission(false);
  await service.run('alice', thread.id, input);
  assert.equal(calls.length, 1);
  title.resolve('Recovered title');
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.title ===
      'Recovered title',
  );
});

for (const action of ['delete', 'shutdown'] as const) {
  test(
    `late titles cannot write after ${action}`,
    { timeout: 5000 },
    async (t) => {
      const { service, memory, threads, title } = fixture(t);
      const thread = await service.createThread('alice', settings);
      await service.run('alice', thread.id, input);
      await until(() => threads.get(thread.id)?.metadata?.status === 'success');
      if (action === 'delete') await service.deleteThread('alice', thread.id);
      else await service.shutdown();
      const writes = t.mock.method(memory, 'updateThread');
      title.resolve('Late title');
      await delay(0);
      assert.equal(writes.mock.callCount(), 0);
      if (action === 'delete')
        assert.equal(
          typeof threads.get(thread.id)?.metadata?.archivedAt,
          'string',
        );
    },
  );
}
