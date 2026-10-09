import {
  mockRpcFetch,
  rpcResponse,
  rpcFailure,
  nextTick,
} from './fixtures/rpc-client.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createModelsResource,
  invalidateAvailableModels,
  onModelsInvalidated,
} from '../apps/web/src/features/models/resource.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const catalog = {
  providers: [
    { id: 'p1', name: 'Provider', type: 'openai', enabled: true, models: [] },
  ],
};

test('model catalog consumers share an RPC request and receive the same snapshot', async (t) => {
  const response = deferred<Response>();
  const calls: Array<[unknown, RequestInit]> = [];
  mockRpcFetch(t, (request, options) => {
    calls.push([request, options]);
    return response.promise;
  });
  const resource = createModelsResource();
  let firstUpdates = 0;
  let secondUpdates = 0;
  const stopFirst = resource.subscribe(() => firstUpdates++);
  const stopSecond = resource.subscribe(() => secondUpdates++);
  const first = resource.refresh();
  assert.equal(resource.refresh(), first);
  await nextTick();
  assert.equal(calls.length, 1);
  assert.equal(
    (calls[0][0] as Request).url,
    'http://localhost/api/rpc/providers/available',
  );
  assert.equal(calls[0][1].credentials, 'same-origin');
  response.resolve(rpcResponse(catalog));
  await first;
  assert.deepEqual(resource.getSnapshot(), { ...catalog, loading: false });
  assert.equal(resource.getSnapshot(), resource.getSnapshot());
  assert.equal(firstUpdates, 2);
  assert.equal(secondUpdates, 2);
  stopFirst();
  stopSecond();
  assert.deepEqual(createModelsResource().getSnapshot().providers, []);
});

test('invalidation aborts a stale request and late responses cannot overwrite the new catalog', async (t) => {
  const responses = [deferred<Response>(), deferred<Response>()];
  const signals: AbortSignal[] = [];
  mockRpcFetch(t, (request) => {
    const response = responses[signals.length];
    signals.push(request.signal);
    return response.promise;
  });
  const resource = createModelsResource();
  const old = resource.refresh();
  await nextTick();
  const current = resource.refresh(true);
  await nextTick();
  assert.equal(signals[0].aborted, true);
  responses[1].resolve(rpcResponse(catalog));
  await current;
  responses[0].resolve(rpcResponse({ providers: [] }));
  await old;
  assert.deepEqual(resource.getSnapshot().providers, catalog.providers);
});

test('catalog errors are localized, retry recovers, and session expiry clears cached data', async (t) => {
  const responses = [
    () => {
      throw new TypeError('offline');
    },
    () => rpcResponse(catalog),
    () => rpcFailure('UNAUTHORIZED', 401),
    () => rpcFailure('INTERNAL_ERROR', 500),
  ];
  mockRpcFetch(t, async () => responses.shift()!());
  const resource = createModelsResource();
  await resource.refresh();
  assert.equal(resource.getSnapshot().error, 'errors.network');
  await resource.refresh();
  assert.equal(resource.getSnapshot().error, undefined);
  assert.equal(resource.getSnapshot().providers.length, 1);
  await resource.refresh();
  assert.equal(resource.getSnapshot().error, 'errors.sessionExpired');
  assert.deepEqual(resource.getSnapshot().providers, []);
  await resource.refresh();
  assert.equal(resource.getSnapshot().error, 'errors.server');
});

test('catalog invalidation subscriptions are removed on session cleanup', () => {
  let calls = 0;
  const stop = onModelsInvalidated(() => calls++);
  invalidateAvailableModels();
  stop();
  invalidateAvailableModels();
  assert.equal(calls, 1);
});
