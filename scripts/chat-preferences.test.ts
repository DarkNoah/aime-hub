import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSettings } from '@aime/shared/threads';
import { createChatPreferencesResource } from '../apps/web/src/components/chat/preferences-resource.js';

const defaults: ChatSettings = { model: null, reasoningEffort: 'auto' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('personal defaults share a read and sequential writes preserve the latest selection', async () => {
  const read = deferred<ChatSettings>();
  const firstWrite = deferred<ChatSettings>();
  const writes: ChatSettings[] = [];
  let reads = 0;
  const resource = createChatPreferencesResource(defaults, {
    read: () => {
      reads++;
      return read.promise;
    },
    save: async (settings) => {
      writes.push(settings);
      return writes.length === 1 ? firstWrite.promise : settings;
    },
  });
  const loading = resource.load();
  assert.equal(resource.load(), loading);
  read.resolve({ model: 'provider/saved', reasoningEffort: 'low' });
  await loading;
  assert.equal(reads, 1);
  assert.equal(resource.getSnapshot().settings.model, 'provider/saved');
  const first = { model: 'provider/next', reasoningEffort: 'low' } as const;
  const latest = { ...first, reasoningEffort: 'high' } as const;
  const saveFirst = resource.save(first);
  const saveLatest = resource.save(latest);
  await Promise.resolve();
  assert.deepEqual(writes, [first]);
  assert.deepEqual(resource.getSnapshot().settings, latest);
  firstWrite.resolve(first);
  assert.equal(await saveFirst, false);
  assert.equal(await saveLatest, true);
  assert.deepEqual(writes, [first, latest]);
  assert.deepEqual(resource.getSnapshot().settings, latest);
  assert.equal(resource.getSnapshot().saving, false);
  assert.equal(await resource.save(latest), false);
  assert.equal(writes.length, 2);
});

test('failed autosave rolls back to the last persisted defaults and allows retry', async () => {
  let fail = true;
  const resource = createChatPreferencesResource(defaults, {
    read: async () => defaults,
    save: async (settings) => {
      if (fail) throw new TypeError('Offline');
      return settings;
    },
  });
  await resource.load();
  await assert.rejects(resource.save({ ...defaults, reasoningEffort: 'max' }));
  assert.deepEqual(resource.getSnapshot().settings, defaults);
  assert.equal(resource.getSnapshot().saving, false);
  fail = false;
  await resource.save({ ...defaults, reasoningEffort: 'none' });
  assert.equal(resource.getSnapshot().settings.reasoningEffort, 'none');
});

test('agent-only preference changes persist and restore without changing the selected model', async () => {
  let saved: ChatSettings = {
    ...defaults,
    model: 'provider/model',
    agentId: null as string | null,
  };
  const api = {
    read: async () => saved,
    save: async (next: ChatSettings) => {
      saved = { ...next, agentId: next.agentId ?? null };
      return saved;
    },
  };
  const resource = createChatPreferencesResource(defaults, api);
  await resource.load();
  assert.equal(
    await resource.save({
      ...resource.getSnapshot().settings,
      agentId: 'code:assistant',
    }),
    true,
  );
  const reopened = createChatPreferencesResource(defaults, api);
  await reopened.load();
  assert.equal(reopened.getSnapshot().settings.agentId, 'code:assistant');
  assert.equal(reopened.getSnapshot().settings.model, 'provider/model');
  await reopened.save({ ...reopened.getSnapshot().settings, agentId: null });
  assert.equal(saved.agentId, null);
});

test('session cleanup ignores stale reads and prevents queued writes under another session', async () => {
  const oldRead = deferred<ChatSettings>();
  let reads = 0;
  let writes = 0;
  const resource = createChatPreferencesResource(defaults, {
    read: async () => (++reads === 1 ? oldRead.promise : defaults),
    save: async (settings) => {
      writes++;
      return settings;
    },
  });
  const stale = resource.load();
  resource.cancel();
  await resource.load();
  oldRead.resolve({ model: 'other/old', reasoningEffort: 'high' });
  await stale;
  assert.deepEqual(resource.getSnapshot().settings, defaults);
  const cancelled = resource.save({ ...defaults, reasoningEffort: 'high' });
  resource.cancel();
  assert.equal(await cancelled, false);
  assert.equal(writes, 0);
});
