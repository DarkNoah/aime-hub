import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';

const runner = {
  async validate() {},
  async createWorkspace() {
    return 'workspace';
  },
  async execute() {},
};

test('new thread runtime fields are stored directly in metadata', async (t) => {
  const { memory, threads } = fakeMemory();
  const service = new ThreadService(memory, runner);
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', {
    model: null,
    reasoningEffort: 'high',
  });
  assert.deepEqual(threads.get(thread.id)?.metadata, {
    model: null,
    createdBy: 'alice',
    workspace: 'workspace',
    queue: [],
    activeId: null,
    acceptedIds: [],
    reasoningEffort: 'high',
    error: null,
    paused: false,
    autoTitle: true,
    usage: null,
  });
});

for (const mixed of [false, true]) {
  test(`legacy metadata is flattened on open and preserves Mastra fields (mixed=${mixed})`, async (t) => {
    const { memory, threads } = fakeMemory();
    const usage = {
      model: 'provider/model',
      maxTokens: 10000,
      totalTokens: 120,
    };
    const queue = [
      {
        id: 'message01',
        model: null,
        reasoningEffort: 'auto',
        parts: [{ type: 'text', text: 'queued' }],
        isImmediate: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const thread = await memory.createThread({
      threadId: 'legacy-thread',
      resourceId: 'user:alice',
      title: 'Existing',
      metadata: {
        model: 'provider/model',
        workspace: 'workspace',
        createdBy: 'alice',
        titlePinned: true,
        customMetadata: { keep: true },
        aime: {
          queue,
          activeId: 'old-run',
          acceptedIds: ['message01'],
          reasoningEffort: 'high',
          error: 'OLD_ERROR',
          paused: true,
          autoTitle: false,
          usage,
        },
        ...(mixed
          ? { usage: null, activeId: null, error: null, paused: false }
          : {}),
      },
    });
    const updateThread = memory.updateThread.bind(memory);
    const writes: Record<string, unknown>[] = [];
    memory.updateThread = async (args) => {
      writes.push(args.metadata!);
      const updated = await updateThread(args);
      // Match the Postgres adapter's shallow merge followed by JSON serialization.
      updated.metadata = JSON.parse(JSON.stringify(updated.metadata));
      threads.set(updated.id, structuredClone(updated));
      return updated;
    };
    const service = new ThreadService(memory, runner);
    t.after(() => service.shutdown());
    const snapshot = await service.getThread('alice', thread.id);
    assert.deepEqual(snapshot.usage, mixed ? null : usage);
    assert.equal(snapshot.thread.error, mixed ? null : 'RUN_INTERRUPTED');
    assert.equal(snapshot.thread.reasoningEffort, 'high');
    assert.equal(snapshot.thread.queue[0].id, 'message01');
    const metadata = threads.get(thread.id)!.metadata!;
    assert.equal(Object.hasOwn(metadata, 'aime'), false);
    assert.deepEqual(metadata.queue, queue);
    assert.deepEqual(metadata.acceptedIds, ['message01']);
    assert.equal(metadata.autoTitle, false);
    assert.equal(metadata.titlePinned, true);
    assert.deepEqual(metadata.customMetadata, { keep: true });
    assert.equal(Object.hasOwn(writes[0], 'titlePinned'), false);
    assert.equal(Object.hasOwn(writes[0], 'customMetadata'), false);
    const reopened = new ThreadService(memory, runner);
    t.after(() => reopened.shutdown());
    assert.deepEqual(
      (await reopened.getThread('alice', thread.id)).usage,
      mixed ? null : usage,
    );
    assert.equal(writes.length, 1);
  });
}
