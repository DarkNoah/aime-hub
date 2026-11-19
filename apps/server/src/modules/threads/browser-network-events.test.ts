import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { BrowserContext, Page, Request, Response } from 'playwright-core';
import { NetworkCaptureEvents } from './browser/network-events.js';
import { NetworkCaptureStore } from './browser/network-store.js';

const scope = { userId: 'user', threadId: 'one' };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'network-events-test-'));
  const store = new NetworkCaptureStore({ directory });
  const context = new EventEmitter();
  const page = Object.assign(new EventEmitter(), {
    requests: async (): Promise<Request[]> => [],
  });
  const tracker = new NetworkCaptureEvents(
    context as unknown as BrowserContext,
    store,
  );
  tracker.track(page as unknown as Page, scope);
  await store.start(scope);
  t.after(async () => {
    tracker.dispose();
    await store.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { context, page, tracker, store };
}

function exchange(
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>,
  body: string,
  size: number,
) {
  let bodyReads = 0;
  const request = {
    url: () =>
      'https://user:masked-secret@unit.test/api?q=page&access_token=masked-secret#masked-secret',
    method: () => 'POST',
    resourceType: () => 'xhr',
    redirectedFrom: () => null,
    headers: () => requestHeaders,
    postDataBuffer: () =>
      Buffer.from('email=a%40test.invalid&password=masked-secret'),
    failure: () => null,
    timing: () => ({ responseEnd: 10 }),
    existingResponse: (): Response => response,
    sizes: async () => ({ responseBodySize: size }),
  } as unknown as Request;
  const response = {
    request: () => request,
    status: () => 201,
    headers: () => responseHeaders,
    body: async () => {
      bodyReads++;
      return Buffer.from(body);
    },
  } as unknown as Response;
  return { request, response, bodyReads: () => bodyReads };
}

test('network records redact URL, headers, form and JSON fields, including a small compressed response', async (t) => {
  const { context, page, store } = await fixture(t);
  const { request, response, bodyReads } = exchange(
    {
      authorization: 'Bearer masked-secret',
      cookie: 'sid=masked-secret',
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://unit.test/prev?token=masked-secret',
    },
    {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'set-cookie': 'session=masked-secret',
    },
    JSON.stringify({
      saved: true,
      nested: [{ apiKey: 'masked-secret', notes: 'Bearer masked-secret' }],
    }),
    211,
  );
  context.emit('request', request);
  page.emit('request', request);
  page.emit('response', response);
  await store.stop(scope);
  page.emit('requestfinished', request);
  await setImmediate();
  const { entries } = await store.list(scope);
  assert.equal(entries.length, 1);
  const record = await store.read(scope, entries[0].id);
  assert.equal(record.state, 'finished');
  assert.equal(record.status, 201);
  assert.equal(record.durationMs! >= 0, true);
  assert.match(record.url, /q=page/);
  assert.doesNotMatch(JSON.stringify(record), /masked-secret/);
  assert.deepEqual(JSON.parse(record.responseBody!), {
    saved: true,
    nested: [{ apiKey: '[redacted]', notes: 'Bearer [redacted]' }],
  });
  assert.equal(bodyReads(), 1);
});

test('unsafe binary, unknown-size and oversized bodies do not call Response.body()', async (t) => {
  const { context, page, store } = await fixture(t);
  for (const [type, encoding, size] of [
    ['application/json', 'br', 12],
    ['application/json', 'gzip, gzip', 20],
    ['application/json', 'deflate', 2049],
    ['application/json', 'identity', 65537],
    ['application/json', 'identity', 0],
    ['application/octet-stream', 'identity', 128],
  ] as const) {
    const { request, response, bodyReads } = exchange(
      {},
      { 'content-type': type, 'content-encoding': encoding },
      'test',
      size,
    );
    context.emit('request', request);
    page.emit('request', request);
    page.emit('response', response);
    page.emit('requestfinished', request);
    await setImmediate();
    assert.equal(bodyReads(), 0);
  }
  const { entries } = await store.list(scope);
  assert.equal(entries.length, 6);
  for (const { id } of entries) {
    const data = await store.read(scope, id);
    assert.ok(data.responseBodyOmitted);
    assert.equal(data.responseBody, undefined);
  }
});

test('backfilled popup requests require both proven ownership and a capture active when each request began', async (t) => {
  const { context, tracker, store } = await fixture(t);
  const other = { ...scope, threadId: 'two' };
  const stale = exchange({}, { 'content-type': 'text/plain' }, 'before', 6);
  context.emit('request', stale.request);
  await store.start(other);
  const allowed = exchange({}, { 'content-type': 'text/plain' }, 'after', 5);
  context.emit('request', allowed.request);
  const popup = Object.assign(new EventEmitter(), {
    requests: async () => [stale.request, allowed.request],
  });
  tracker.track(popup as unknown as Page, other);
  await setImmediate();
  const records = await store.list(other);
  assert.equal(records.entries.length, 1);
  assert.equal(
    (await store.read(other, records.entries[0].id)).responseBody,
    'after',
  );
  assert.equal((await store.list(scope)).total, 0);
});

test('failed requests and page closure finish pending records without leaking driver error details', async (t) => {
  const { context, page, store } = await fixture(t);
  const failed = exchange({}, {}, '', 0).request;
  const incomplete = exchange({}, {}, '', 0).request;
  Object.assign(failed, {
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET masked-secret' }),
  });
  for (const request of [failed, incomplete]) {
    context.emit('request', request);
    page.emit('request', request);
  }
  page.emit('requestfailed', failed);
  page.emit('close');
  const { entries } = await store.list(scope);
  const details = await Promise.all(
    entries.map((entry) => store.read(scope, entry.id)),
  );
  assert.deepEqual(details.map((detail) => detail.error).sort(), [
    'net::ERR_CONNECTION_RESET',
    'page closed',
  ]);
  assert.ok(details.every((detail) => detail.state === 'failed'));
  assert.doesNotMatch(JSON.stringify(details), /masked-secret/);
});
