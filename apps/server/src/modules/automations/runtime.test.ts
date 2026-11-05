import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { fixture, input, personal, until } from './test-fixture.js';

test('scheduled runs can exceed ten minutes and still stop on service shutdown', async (t) => {
  // Advance signal deadlines without waiting ten real minutes or advancing the
  // scheduler's polling timers. This also catches a reintroduced run deadline.
  const deadlines: { milliseconds: number; controller: AbortController }[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });

  const model = createMockModel({ mockText: 'Done', version: 'v2' });
  const streams: { signal: AbortSignal; complete: () => void }[] = [];
  t.mock.method(
    model,
    'doStream',
    async ({ abortSignal }: { abortSignal: AbortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          const abort = () => controller.error(abortSignal.reason);
          abortSignal.addEventListener('abort', abort, { once: true });
          streams.push({
            signal: abortSignal,
            complete() {
              abortSignal.removeEventListener('abort', abort);
              controller.enqueue({ type: 'text-start', id: 'result' });
              controller.enqueue({
                type: 'text-delta',
                id: 'result',
                delta: 'Completed after ten minutes',
              });
              controller.enqueue({ type: 'text-end', id: 'result' });
              controller.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              controller.close();
            },
          });
        },
      }),
    }),
  );

  const { service, mastra, shutdown } = await fixture(t, { model });
  const task = await service.create('alice', personal, input);
  await mastra.schedules.run(task.id);
  await until(
    () => Promise.resolve(streams.length),
    (count) => count === 1,
  );

  for (const deadline of deadlines) {
    if (deadline.milliseconds <= 11 * 60_000)
      deadline.controller.abort(new DOMException('Timed out', 'TimeoutError'));
  }
  await delay(30);
  assert.equal(streams[0].signal.aborted, false);
  assert.equal((await service.history('alice', task.id))[0].status, 'running');

  streams[0].complete();
  const completed = await until(
    () => service.history('alice', task.id),
    (rows) => rows[0]?.status === 'succeeded',
  );
  assert.equal(completed[0].text, 'Completed after ten minutes');
  assert.equal(completed[0].error, null);

  await mastra.schedules.run(task.id);
  await until(
    () => Promise.resolve(streams.length),
    (count) => count === 2,
  );
  await shutdown();
  assert.equal(streams[1].signal.aborted, true);
  const interrupted = await until(
    () => service.history('alice', task.id),
    (rows) => rows.some((row) => row.status === 'failed'),
  );
  assert.equal(
    interrupted.find((row) => row.status === 'failed')?.error,
    'RUN_INTERRUPTED',
  );
});
