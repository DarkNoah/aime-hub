import assert from 'node:assert/strict';
import test from 'node:test';
import { eventStream } from '../apps/server/src/modules/threads/event-stream.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('SSE handles large snapshots and releases subscriptions when readers cancel', async () => {
  let send!: (event: string, data: unknown) => void;
  let disposed = 0;
  const response = eventStream(
    new AbortController().signal,
    (emit) => {
      send = emit;
      return () => {
        disposed++;
      };
    },
    async () => undefined,
  );
  const reader = response.body!.getReader();
  await reader.read(); // Initial comment flushes headers.
  await tick();
  const value = 'x'.repeat(3 * 1024 * 1024);
  send('snapshot', { value });
  const snapshot = await reader.read();
  assert.equal(snapshot.done, false);
  assert.match(new TextDecoder().decode(snapshot.value), /^event: snapshot/);
  await reader.cancel();
  assert.equal(disposed, 1);
});

test('SSE cancels a pending subscription and bounds stalled consumers', async () => {
  const controller = new AbortController();
  let resolve!: (stop: () => void) => void;
  let disposed = 0;
  const response = eventStream(
    controller.signal,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    async () => undefined,
  );
  await tick();
  controller.abort();
  resolve(() => {
    disposed++;
  });
  await tick();
  assert.equal(disposed, 1);
  await response.body!.cancel();

  let emit!: (event: string, data: unknown) => void;
  const stalled = eventStream(
    new AbortController().signal,
    (send) => {
      emit = send;
      return () => {
        disposed++;
      };
    },
    async () => undefined,
  );
  await tick();
  emit('snapshot', 'x'.repeat(3 * 1024 * 1024));
  emit('update', {});
  assert.equal(disposed, 2);
  await stalled.body!.cancel();
});
