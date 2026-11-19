import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  NetworkCaptureStore,
  networkRetentionMs,
} from './browser/network-store.js';

const alice = { userId: 'alice', threadId: 'thread' };
const bob = { ...alice, userId: 'bob' };
const project = { ...alice, projectId: 'project' };
const request = {
  url: 'https://example.test/items',
  method: 'POST',
  resourceType: 'fetch',
};

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'network-store-test-'));
  let time = Date.now();
  const store = new NetworkCaptureStore({ directory, now: () => time });
  await store.cleanup();
  t.after(async () => {
    await store.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    directory,
    advance(ms: number) {
      time += ms;
    },
    now: () => time,
  };
}

test('records isolate users, threads and projects and finish after stopping', async (t) => {
  const { store, directory } = await setup(t);
  const capturing = await store.start(alice);
  assert.deepEqual(await store.start(alice), capturing);
  const handle = store.begin(alice, request)!;
  assert.ok(handle);
  const first = store.update(handle, {
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: '{"name":"item"}',
  });
  const next = store.update(handle, {
    status: 201,
    responseHeaders: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await store.stop(alice), capturing);
  assert.equal(store.begin(alice, request), undefined);
  const done = store.update(handle, {
    state: 'finished',
    responseBody: '{"ok":true}',
    durationMs: 5,
  });
  const detail = await store.read(alice, handle.id);
  await Promise.all([first, next, done]);
  assert.equal(detail.requestBody, '{"name":"item"}');
  assert.equal(detail.responseBody, '{"ok":true}');
  assert.equal(detail.status, 201);
  const result = await store.list(alice, {
    url: '/items',
    status: 201,
    method: 'post',
  });
  assert.equal(result.total, 1);
  assert.equal(result.active, false);
  assert.equal(result.entries[0].state, 'finished');
  assert.equal('requestBody' in result.entries[0], false);
  for (const other of [bob, project, { ...alice, threadId: 'other' }]) {
    assert.equal((await store.list(other)).total, 0);
    await assert.rejects(store.read(other, handle.id), /not found or expired/);
  }
  await assert.rejects(
    store.read(alice, '../record.bin'),
    /not found or expired/,
  );
  const [folder] = await readdir(directory);
  assert.match(folder, /^\d+-[a-f0-9]{64}-/);
  const file = join(directory, folder, 'record.bin');
  const data = await readFile(file);
  assert.equal(data.includes(detail.url), false);
  assert.equal(data.includes(detail.requestBody!), false);
  assert.equal(data.includes(detail.responseBody!), false);
  if (process.getuid) assert.equal((await stat(file)).mode & 0o077, 0);
  await store.start(bob);
  const other = store.begin(bob, request)!;
  await store.read(bob, other.id);
  const destination = (await readdir(directory)).find((name) =>
    name.endsWith(other.id),
  )!;
  await writeFile(join(directory, destination, 'record.bin'), data);
  await assert.rejects(store.read(bob, other.id), /integrity verification/);
});

test('a stopped recording cannot capture delayed events into a new generation', async (t) => {
  const { store, now } = await setup(t);
  const before = store.captureTicket();
  const start = store.start(alice);
  const ticket = store.captureTicket();
  const stopping = store.stop(alice);
  assert.equal((await stopping).captureId, (await start).captureId);
  assert.equal(store.isActive(alice), false);
  const current = await store.start(alice);
  assert.equal(store.begin(alice, request, before), undefined);
  assert.equal(store.begin(alice, request, ticket), undefined);
  assert.equal(
    store.begin(alice, { ...request, startedAt: now() - 1 }),
    undefined,
  );
  assert.equal(
    store.begin(alice, request, store.captureTicket())?.captureId,
    current.captureId,
  );
  await store.start(project);
  await store.start(bob);
  store.stopScopeOwner(alice.userId);
  assert.equal(store.isActive(alice), false);
  assert.equal(store.isActive(project), true);
  assert.equal(store.isActive(bob), true);
  await store.removeThread(alice.threadId);
  assert.equal(store.isActive(project), false);
  assert.equal(store.isActive(bob), false);
  assert.equal((await store.list(alice)).total, 0);
});

test('the fifteen-minute lifetime is per request and updates do not extend it', async (t) => {
  const { store, directory, advance } = await setup(t);
  await store.start(alice);
  const first = store.begin(alice, request)!;
  advance(networkRetentionMs - 1);
  const second = store.begin(alice, request)!;
  await store.update(first, { status: 200 });
  assert.equal((await store.read(alice, first.id)).status, 200);
  advance(1);
  assert.equal(store.isRetained(first), false);
  assert.equal(store.isRetained(second), true);
  await assert.rejects(store.read(alice, first.id), /not found or expired/);
  assert.equal((await store.list(alice)).total, 1);
  await store.update(first, { responseBody: 'late' });
  await store.cleanup();
  assert.equal((await readdir(directory)).length, 1);
  assert.equal(store.isActive(alice), true);
  assert.ok(store.begin(alice, request));
});

test('a new instance sweeps expired time-named directories without touching live or unrelated data', async (t) => {
  const { store, directory, advance, now } = await setup(t);
  await store.start(alice);
  const entry = store.begin(alice, request)!;
  await store.read(alice, entry.id);
  await mkdir(join(directory, 'unrelated'));
  const other = new NetworkCaptureStore({ directory, now });
  t.after(() => other.dispose());
  await other.cleanup();
  assert.equal((await readdir(directory)).length, 2);
  advance(networkRetentionMs);
  const restarted = new NetworkCaptureStore({ directory, now });
  t.after(() => restarted.dispose());
  await restarted.cleanup();
  assert.deepEqual(await readdir(directory), ['unrelated']);
});

test('expiry timer removes a request from disk without another browser operation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { store, directory, advance } = await setup(t);
  await store.start(alice);
  const handle = store.begin(alice, request)!;
  await store.read(alice, handle.id);
  advance(networkRetentionMs);
  t.mock.timers.tick(networkRetentionMs);
  const deadline = Date.now() + 2000;
  while ((await readdir(directory)).length > 0) {
    assert.ok(
      Date.now() < deadline,
      'expired request directory was not removed',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});
