import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
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
const secret = 'test-secret-for-chat-browser-history';

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

test('a fresh process can query earlier captures without starting a recording', async (t) => {
  const { directory, now, advance } = await setup(t);
  const storeModule = new URL('./browser/network-store.ts', import.meta.url);
  const writer = `
    import { NetworkCaptureStore } from ${JSON.stringify(storeModule.href)};
    const { directory, secret, firstTime, scope, request } = JSON.parse(process.argv[1]);
    let time = firstTime;
    const store = new NetworkCaptureStore({ directory, secret, now: () => time });
    const ids = [];
    for (const status of [201, 201, 403]) {
      await store.start(scope);
      const handle = store.begin(scope, request);
      await store.update(handle, { state: 'finished', status, responseBody: 'response ' + status });
      await store.stop(scope);
      ids.push(handle.id);
      time += 1000;
    }
    // Exit with the capture files in place, without any shutdown-time index flush.
    process.stdout.write(JSON.stringify(ids));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    writer,
    JSON.stringify({
      directory,
      secret,
      firstTime: now(),
      scope: alice,
      request,
    }),
  ]);
  const [first, second, third] = JSON.parse(stdout) as string[];
  advance(2000);
  const reader = new NetworkCaptureStore({ directory, secret, now });
  t.after(() => reader.dispose());
  assert.equal((await reader.read(alice, third)).responseBody, 'response 403');
  const page = await reader.list(alice, {
    url: '/items',
    method: 'post',
    status: 201,
    offset: 1,
    limit: 1,
  });
  assert.equal(page.active, false);
  assert.equal(page.total, 2);
  assert.deepEqual(
    page.entries.map((entry) => entry.id),
    [first],
  );
  const history = await reader.list(alice);
  assert.deepEqual(
    history.entries.map((entry) => entry.id),
    [third, second, first],
  );
  assert.equal(
    new Set(history.entries.map((entry) => entry.captureId)).size,
    3,
  );
  for (const unrelated of [bob, project, { ...alice, threadId: 'other' }]) {
    assert.equal((await reader.list(unrelated)).total, 0);
    await assert.rejects(reader.read(unrelated, first), /not found or expired/);
  }
  advance(networkRetentionMs - 2001);
  assert.equal((await reader.read(alice, first)).status, 201);
  advance(1);
  await assert.rejects(reader.read(alice, first), /not found or expired/);
  assert.deepEqual(
    (await reader.list(alice)).entries.map((entry) => entry.id),
    [third, second],
  );
  await reader.cleanup();
  assert.equal(
    (await readdir(directory)).some((name) => name.endsWith(first)),
    false,
  );
});

test('history rejects a changed timestamp, a substituted scope, and a different server secret', async (t) => {
  const { directory, now, advance } = await setup(t);
  const options = { directory, now, secret };
  const writer = new NetworkCaptureStore(options);
  await writer.start(alice);
  const first = writer.begin(alice, request)!;
  await writer.start(bob);
  const second = writer.begin(bob, request)!;
  await Promise.all([
    writer.read(alice, first.id),
    writer.read(bob, second.id),
  ]);
  await writer.dispose();
  const rotated = new NetworkCaptureStore({
    ...options,
    secret: secret + '-different',
  });
  t.after(() => rotated.dispose());
  assert.equal((await rotated.list(alice)).total, 0);
  await assert.rejects(rotated.read(alice, first.id));

  const folders = await readdir(directory);
  const source = folders.find((name) => name.endsWith(first.id))!;
  const destination = folders.find((name) => name.endsWith(second.id))!;
  await writeFile(
    join(directory, destination, 'record.bin'),
    await readFile(join(directory, source, 'record.bin')),
  );
  advance(5000);
  await rename(
    join(directory, source),
    join(directory, source.replace(/^\d+/, String(now()))),
  );
  const restored = new NetworkCaptureStore(options);
  t.after(() => restored.dispose());
  for (const [scope, id] of [
    [alice, first.id],
    [bob, second.id],
  ] as const) {
    assert.equal((await restored.list(scope)).total, 0);
    await assert.rejects(restored.read(scope, id));
  }
});

test('deleting a thread before its first history query removes only its own files', async (t) => {
  const { directory, now } = await setup(t);
  const options = { directory, now, secret };
  const writer = new NetworkCaptureStore(options);
  const otherThread = { ...alice, threadId: 'other' };
  const scopes = [alice, bob, project, otherThread];
  const ids: string[] = [];
  for (const scope of scopes) {
    await writer.start(scope);
    const { id } = writer.begin(scope, request)!;
    await writer.read(scope, id);
    ids.push(id);
  }
  await writer.dispose();
  const remover = new NetworkCaptureStore(options);
  await remover.removeThread(alice.threadId);
  await remover.dispose();
  const reader = new NetworkCaptureStore(options);
  t.after(() => reader.dispose());
  const remaining = await readdir(directory);
  for (const id of ids.slice(0, 3))
    assert.equal(
      remaining.some((name) => name.endsWith(id)),
      false,
    );
  assert.equal((await reader.list(project)).total, 0);
  assert.equal((await reader.read(otherThread, ids[3])).url, request.url);
});
