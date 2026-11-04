import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { Agent } from '@mastra/core/agent';
import type { BackgroundTaskOperation } from '@mastra/core/background-tasks';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve, type ToolExecutionContext } from '@mastra/core/tools';
import type { PluginContext } from '@app/plugin-sdk/server';
import { createBacktestTools } from '../mastra/tools/backtests.js';
import type { QuantDependencies } from '../mastra/tools/context.js';
import type { BacktestInput, BacktestRun } from '../strategy-types.js';
import { BACKTEST_BACKGROUND_TIMEOUT_MS } from '../mastra/tools/backtest-background.js';

const metrics = {
  total_points: 128,
  max_drawdown_points: 14,
  profit_factor: 2.4,
  trade_count: 12,
};
const optimization = {
  status: 'completed',
  metric: 'total_points',
  best_value: 128,
  best_parameters: { window: 4 },
  best_trial: 1,
  validation: { status: 'succeeded', metrics: { total_points: 36 } },
  trials: [{ number: 1 }],
};

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for the native background task');
}

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
      artifact: async (_id: string, name: string) => ({
        hash: 'result-hash',
        text: JSON.stringify(
          name === 'optimization'
            ? optimization
            : {
                status: 'succeeded',
                pnl_unit: 'points',
                metrics,
                metric_notes: { sharpe: '点数回测不计算资金夏普' },
                logs: Array.from({ length: 25 }, (_, i) => ({
                  message: `log-${i}`,
                })),
                trades: Array.from({ length: 12 }, () => ({ id: 'trade' })),
                equity_curve: [{ time: 1, equity: 128 }],
              },
        ),
      }),
      createOptimizationVersion: async () => {
        job.optimization_version_id = 'optimized-version';
        return { version: { id: job.optimization_version_id } };
      },
    },
    // Native background tasks must stay active until this worker finishes.
    wake: () => {
      counts.wake++;
    },
  } as unknown as QuantDependencies;
  const context = {
    assertEnabled: async () => {},
    database: { query: async () => [{ role: 'admin', banned: false }] },
  } as unknown as PluginContext;
  const tools = createBacktestTools(context, () => deps);
  async function call(
    name: string,
    value: object,
    signal?: AbortSignal,
    execution: Partial<ToolExecutionContext> = {},
  ) {
    const definition = tools.find(
      (tool) => tool.id === `plugin_vibe_quant_${name}`,
    )!;
    const [tool] = await definition.getTools();
    assert.ok(tool && 'execute' in tool && tool.execute);
    return tool.execute(value, {
      requestContext,
      abortSignal: signal,
      observe: noopObserve,
      ...execution,
    });
  }
  return { input, deps, counts, call, tools, requestContext, job: () => job };
}

for (const name of ['backtest_start', 'backtest_optimize']) {
  test(`${name} direct execution acknowledges the queue and survives conversation abort`, async () => {
    const f = fixture();
    const [tool] = await f.tools
      .find((item) => item.id === `plugin_vibe_quant_${name}`)!
      .getTools();
    assert.ok('background' in tool);
    assert.deepEqual(tool.background, {
      enabled: true,
      defaultDisposition: 'deferred',
      timeoutMs: BACKTEST_BACKGROUND_TIMEOUT_MS,
      maxRetries: 0,
    });
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

  for (const outcome of ['completed', 'cancelled', 'timed_out']) {
    test(`${name} native deferred execution: ${outcome}`, async (t) => {
      const f = fixture();
      const [tool] = await f.tools
        .find((item) => item.id === `plugin_vibe_quant_${name}`)!
        .getTools();
      assert.ok('background' in tool && tool.background);
      if (outcome === 'timed_out') tool.background.timeoutMs = 1000;
      let calls = 0;
      const model = new MastraLanguageModelV2Mock({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              const first = ++calls === 1;
              if (first)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'quant-call',
                  toolName: tool.id,
                  // No _background override: the tool must dispatch in the background by default.
                  input: JSON.stringify({
                    ...f.input,
                    ...(name === 'backtest_optimize'
                      ? {
                          optimization: {
                            metric: 'total_points',
                            search_space: {
                              window: { type: 'int', low: 2, high: 5 },
                            },
                          },
                        }
                      : {}),
                  }),
                });
              else {
                controller.enqueue({ type: 'text-start', id: 'reply' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'reply',
                  delta: '后台任务已启动。',
                });
                controller.enqueue({ type: 'text-end', id: 'reply' });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: first ? 'tool-calls' : 'stop',
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
              });
              controller.close();
            },
          }),
        }),
      });
      const agent = new Agent({
        id: 'quant-test',
        name: 'Quant test',
        instructions: 'Run the requested backtest.',
        model,
        tools: { [tool.id]: tool },
      });
      const mastra = new Mastra({
        agents: { quant: agent },
        storage: new InMemoryStore(),
        logger: false,
        // If the tool forgets its own budget, this test times out before the worker completes.
        backgroundTasks: { enabled: true, defaultTimeoutMs: 50 },
      });
      t.after(() => mastra.shutdown());
      const controller = new AbortController();
      const output = await agent.stream('Run the backtest', {
        requestContext: f.requestContext,
        abortSignal: controller.signal,
      });
      const chunks: string[] = [];
      for await (const chunk of output.fullStream) chunks.push(chunk.type);
      assert.ok(chunks.includes('background-task-started'));
      assert.equal(f.counts.enqueue, 1);
      const manager = mastra.backgroundTaskManager!;
      const { tasks } = await manager.listTasks({ toolName: tool.id });
      assert.equal(tasks.length, 1);
      const taskId = tasks[0].id;
      assert.equal(
        tasks[0].timeoutMs,
        outcome === 'timed_out' ? 1000 : BACKTEST_BACKGROUND_TIMEOUT_MS,
      );
      assert.equal(tasks[0].status, 'running');
      controller.abort();
      await delay(80);
      assert.equal(
        f.counts.cancel,
        0,
        'stopping the foreground must not cancel the native task',
      );
      assert.equal((await manager.getTask(taskId))!.status, 'running');
      if (outcome === 'timed_out') {
        await waitFor(
          async () => (await manager.getTask(taskId))!.status === 'timed_out',
        );
        assert.equal(f.counts.cancel, 1);
        assert.equal(f.job().status, 'cancelled');
      } else if (outcome === 'cancelled') {
        await manager.cancel(taskId);
        await waitFor(() => f.counts.cancel === 1);
        assert.equal(f.job().status, 'cancelled');
        assert.equal((await manager.getTask(taskId))!.status, 'cancelled');
      } else {
        f.job().status = 'completed';
        await waitFor(
          async () => (await manager.getTask(taskId))!.status === 'completed',
        );
        const report = (await manager.getTask(taskId))!.result as {
          run_id: string;
          run: BacktestRun;
          terminal: boolean;
          result: {
            metrics: typeof metrics;
            pnl_unit: string;
            counts: { trades: number };
            logs: unknown[];
            trades?: unknown;
            equity_curve?: unknown;
          };
          optimization: typeof optimization & { trial_count: number };
        };
        assert.equal(report.run_id, f.job().id);
        assert.equal(report.run.status, 'completed');
        assert.equal(report.terminal, true);
        assert.deepEqual(report.result.metrics, metrics);
        assert.equal(report.result.pnl_unit, 'points');
        assert.equal(report.result.counts.trades, 12);
        assert.equal(report.result.logs.length, 20);
        assert.equal(report.result.trades, undefined);
        assert.equal(report.result.equity_curve, undefined);
        if (name === 'backtest_optimize') {
          assert.deepEqual(report.optimization.best_parameters, { window: 4 });
          assert.equal(report.optimization.best_value, 128);
          assert.equal(
            report.optimization.validation!.metrics.total_points,
            36,
          );
          assert.equal(report.optimization.trial_count, 1);
          assert.equal(report.optimization.trials, undefined);
          assert.equal(report.run.optimization_version_id, 'optimized-version');
        } else assert.equal(report.optimization, null);
      }
      assert.equal(f.counts.enqueue, 1);
    });
  }
}

test('native cancellation settles immediately even while a status query is pending', async () => {
  const f = fixture();
  let operation!: BackgroundTaskOperation<unknown>;
  let release!: (run: BacktestRun) => void;
  f.deps.records.run = async () => {
    f.counts.read++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  await f.call('backtest_start', f.input, undefined, {
    background: {
      taskId: 'native-task',
      disposition: 'deferred',
      adopt: (value) => {
        operation = value;
      },
    },
  });
  const rejected = assert.rejects(operation.completion, /用户中止了操作/);
  await waitFor(() => f.counts.read === 1);
  await operation.cancel!();
  await rejected;
  release(f.job());
  await setImmediate();
  assert.equal(f.counts.cancel, 1);
  assert.equal(f.counts.read, 1);
});

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
