import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPython } from '../server/strategies/runner.js';

test('default backtest execution survives the former execution deadlines', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'quant-no-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = runPython(
    'python3',
    ['-c', 'import time; time.sleep(0.2)'],
    directory,
    new AbortController().signal,
  );
  t.mock.timers.tick(16 * 60_000);
  await task;
});

test('unlimited execution still terminates on explicit cancellation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'quant-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const task = runPython(
    'python3',
    ['-c', 'import time; time.sleep(60)'],
    directory,
    controller.signal,
  );
  const rejected = assert.rejects(task, /用户中止了操作/);
  controller.abort();
  await rejected;
});
