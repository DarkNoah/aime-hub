import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';
import type { PluginContext } from '@app/plugin-sdk/server';
import { createBacktestTools } from '../mastra/tools/backtests.js';
import type { QuantDependencies } from '../mastra/tools/context.js';
import type { BacktestInput, BacktestRun } from '../strategy-types.js';

function fixture() {
  const strategyId = randomUUID();
  const versionId = randomUUID();
  const requestContext = new RequestContext();
  requestContext.set('userId', 'admin');
  const counts = { enqueue: 0, wake: 0, read: 0, cancel: 0 };
  const input = {
    version_id: versionId,
    symbol: 'SSE.000852',
    start: 1_700_000_000,
    end: 1_700_086_400,
    execution_model: 'points',
  };
  let job: BacktestRun;
  const deps = {
    config: { engine: 'tqsdk' },
    state: {
      instrument: async () => ({ symbol: input.symbol, kind: 'index' }),
    },
    records: {
      version: async () => ({
        id: versionId,
        strategy_id: strategyId,
        parameters: {},
      }),
      detail: async () => ({ id: strategyId }),
      enqueue: async (
        _user: string,
        _strategy: string,
        config: BacktestInput,
      ) => {
        counts.enqueue++;
        job = {
          id: randomUUID(),
          strategy_id: strategyId,
          version_id: versionId,
          version_number: 1,
          source_hash: 'source-hash',
          engine: 'tqsdk',
          config,
          status: 'queued',
          message: '',
          cancel_requested: false,
          created_at: new Date().toISOString(),
          started_at: null,
          finished_at: null,
        };
        return job;
      },
      run: async () => {
        counts.read++;
        return job;
      },
      cancel: async () => {
        counts.cancel++;
        job.status = 'cancelled';
        return job;
      },
      artifact: async () => null,
    },
    // Deliberately leave the worker unfinished: tools must not wait for it.
    wake: () => {
      counts.wake++;
    },
  } as unknown as QuantDependencies;
  const context = {
    assertEnabled: async () => {},
    database: { query: async () => [{ role: 'admin', banned: false }] },
  } as unknown as PluginContext;
  const tools = createBacktestTools(context, () => deps);
  async function call(name: string, value: object, signal?: AbortSignal) {
    const definition = tools.find(
      (tool) => tool.id === `plugin_vibe_quant_${name}`,
    )!;
    const [tool] = await definition.getTools();
    assert.ok(tool && 'execute' in tool && tool.execute);
    return tool.execute(value, {
      requestContext,
      abortSignal: signal,
      observe: noopObserve,
    });
  }
  return { input, deps, counts, call, tools, requestContext, job: () => job };
}

for (const name of ['backtest_start', 'backtest_optimize']) {
  test(`${name} acknowledges the queued task without waiting and survives conversation abort`, async () => {
    const f = fixture();
    const [tool] = await f.tools
      .find((item) => item.id === `plugin_vibe_quant_${name}`)!
      .getTools();
    assert.ok('background' in tool);
    assert.deepEqual(tool.background, { enabled: false });
    const controller = new AbortController();
    const result = await f.call(
      name,
      {
        ...f.input,
        ...(name === 'backtest_optimize'
          ? {
              optimization: {
                metric: 'total_points',
                search_space: { window: { type: 'int', low: 2, high: 5 } },
              },
            }
          : {}),
      },
      controller.signal,
    );
    assert.equal(result.run_id, result.run.id);
    assert.equal(result.run.status, 'queued');
    if (name === 'backtest_optimize')
      assert.equal(result.run.config.optimization.timeout_seconds, 0);
    assert.match(result.message, /已提交/);
    assert.deepEqual(f.counts, { enqueue: 1, wake: 1, read: 0, cancel: 0 });
    controller.abort();
    await setImmediate();
    assert.equal(f.job().status, 'queued');
    assert.equal(f.counts.cancel, 0);
    const cancelled = await f.call('backtest_cancel', {
      run_id: result.run_id,
    });
    assert.equal(cancelled.run.status, 'cancelled');
    assert.equal(f.counts.cancel, 1);
  });
}

test('status reads once by default and reports active and terminal states', async () => {
  const f = fixture();
  const started = await f.call('backtest_start', f.input);
  for (const status of [
    'queued',
    'preparing',
    'running',
    'completed',
    'failed',
    'cancelled',
  ] as const) {
    f.job().status = status;
    f.counts.read = 0;
    // A second read catches accidental polling without waiting for a timer.
    f.deps.records.run = async () => {
      assert.equal(++f.counts.read, 1, 'status must not poll the worker');
      return f.job();
    };
    const result = await f.call('backtest_status', {
      run_id: started.run_id,
    });
    assert.equal(result.run.status, status);
    assert.equal(
      result.terminal,
      !['queued', 'preparing', 'running'].includes(status),
    );
    assert.equal(f.counts.read, 1);
  }
});

test('aborting a pending status read returns immediately without cancelling the background task', async () => {
  const f = fixture();
  const started = await f.call('backtest_start', f.input);
  let release!: (value: BacktestRun) => void;
  let reading!: () => void;
  const ready = new Promise<void>((resolve) => {
    reading = resolve;
  });
  f.deps.records.run = () =>
    new Promise((resolve) => {
      release = resolve;
      reading();
    });
  const controller = new AbortController();
  const pending = f.call(
    'backtest_status',
    { run_id: started.run_id },
    controller.signal,
  );
  await ready;
  controller.abort();
  assert.deepEqual(await pending, {
    cancelled: true,
    message: '用户中止了操作',
  });
  release(f.job());
  await setImmediate();
  assert.equal(f.job().status, 'queued');
  assert.equal(f.counts.cancel, 0);
});
