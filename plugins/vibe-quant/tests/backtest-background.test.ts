import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { MockMemory } from '@mastra/core/memory';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve, type ToolExecutionContext } from '@mastra/core/tools';
import type { PluginContext } from '@app/plugin-sdk/server';
import { createBacktestTools } from '../mastra/tools/backtests.js';
import type { QuantDependencies } from '../mastra/tools/context.js';
import type { BacktestInput, BacktestRun } from '../strategy-types.js';
import { BACKTEST_BACKGROUND_TIMEOUT_MS } from '../mastra/tools/backtest-background.js';
import { quantAgent } from '../mastra/agents/quant-agent.js';

const metrics = {
  total_points: 128,
  max_drawdown_points: 14,
  profit_factor: 2.4,
  trade_count: 12,
};
const backtestMetrics = { ...metrics, total_points: 200 };
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
  const optimizedVersionId = randomUUID();
  const defaults = { window: 2, unchanged: 9 };
  const optimizedParameters = { ...defaults, window: 4 };
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
  const jobs = new Map<string, BacktestRun>();
  const deps = {
    config: { engine: 'tqsdk' },
    state: {
      instrument: async () => ({ symbol: input.symbol, kind: 'index' }),
    },
    records: {
      version: async (_user: string, id: string) => ({
        id,
        strategy_id: strategyId,
        parameters: id === optimizedVersionId ? optimizedParameters : defaults,
      }),
      detail: async () => ({ id: strategyId }),
      enqueue: async (
        _user: string,
        _strategy: string,
        config: BacktestInput,
        engine: BacktestRun['engine'],
      ) => {
        counts.enqueue++;
        job = {
          id: randomUUID(),
          strategy_id: strategyId,
          version_id: config.version_id,
          version_number: 1,
          source_hash: 'source-hash',
          engine,
          config: {
            ...config,
            parameters: config.optimization ? defaults : config.parameters,
          },
          status: 'queued',
          message: '',
          cancel_requested: false,
          created_at: new Date().toISOString(),
          started_at: null,
          finished_at: null,
        };
        jobs.set(job.id, job);
        return job;
      },
      runs: async () =>
        [...jobs.values()].filter((run) => !run.config.optimization),
      run: async (_user: string, id: string) => {
        counts.read++;
        return jobs.get(id)!;
      },
      cancel: async (_user: string, id: string) => {
        counts.cancel++;
        const run = jobs.get(id)!;
        run.status = 'cancelled';
        return run;
      },
      artifact: async (id: string, name: string) => ({
        hash: 'result-hash',
        text: JSON.stringify(
          name === 'optimization'
            ? optimization
            : {
                status: 'succeeded',
                pnl_unit: 'points',
                metrics:
                  jobs.get(id)?.version_id === optimizedVersionId
                    ? backtestMetrics
                    : metrics,
                metric_notes: { sharpe: '点数回测不计算资金夏普' },
                logs: Array.from({ length: 25 }, (_, i) => ({
                  message: `log-${i}`,
                })),
                trades: Array.from({ length: 12 }, () => ({ id: 'trade' })),
                equity_curve: [{ time: 1, equity: 128 }],
              },
        ),
      }),
      createOptimizationVersion: async (_user: string, id: string) => {
        jobs.get(id)!.optimization_version_id = optimizedVersionId;
        return {
          version: { id: optimizedVersionId, parameters: optimizedParameters },
        };
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
  return {
    input,
    deps,
    counts,
    call,
    tools,
    requestContext,
    optimizedVersionId,
    optimizedParameters,
    jobs,
    job: () => job,
    seed: () =>
      deps.records.enqueue(
        'admin',
        strategyId,
        input as BacktestInput,
        'tqsdk',
      ),
  };
}

async function assertFollowup(f: ReturnType<typeof fixture>) {
  const optimizationRun = [...f.jobs.values()].find(
    (run) => run.config.optimization,
  )!;
  await waitFor(() => f.counts.wake === 2);
  const backtest = f.job();
  assert.notEqual(backtest.id, optimizationRun.id);
  assert.equal(backtest.version_id, f.optimizedVersionId);
  assert.equal(backtest.strategy_id, optimizationRun.strategy_id);
  assert.equal(backtest.engine, optimizationRun.engine);
  assert.deepEqual(backtest.config.parameters, f.optimizedParameters);
  const expected = {
    ...optimizationRun.config,
    version_id: f.optimizedVersionId,
    parameters: f.optimizedParameters,
  };
  delete expected.optimization;
  assert.deepEqual(
    backtest.config,
    expected,
    'rerun the complete original period with the winning defaults',
  );
  assert.equal(backtest.status, 'queued');
  assert.deepEqual(await f.deps.records.runs('admin', backtest.strategy_id), [
    backtest,
  ]);
}

for (const name of ['backtest_start', 'backtest_optimize']) {
  for (const isBackgroundTask of [false, true]) {
    test(`${name} waits for final metrics without an adoption context (background=${isBackgroundTask})`, async () => {
      const f = fixture();
      const [tool] = await f.tools
        .find((item) => item.id === `plugin_vibe_quant_${name}`)!
        .getTools();
      assert.ok('background' in tool);
      assert.deepEqual(tool.background, {
        enabled: true,
        defaultDisposition: 'foreground',
        timeoutMs: BACKTEST_BACKGROUND_TIMEOUT_MS,
        maxRetries: 0,
      });
      let settled = false;
      const pending = f
        .call(
          name,
          {
            ...f.input,
            ...(name === 'backtest_optimize'
              ? {
                  parameters: { window: 99, unchanged: 99 },
                  duration: 300,
                  point_cost: 0.5,
                  slippage_ticks: 3,
                  optimization: {
                    metric: 'total_points',
                    search_space: { window: { type: 'int', low: 2, high: 5 } },
                    validation_start: f.input.start + 3600,
                  },
                }
              : {}),
          },
          undefined,
          {
            agent: {
              agentId: 'quant-test',
              toolCallId: 'test-call',
              messages: [],
              suspend: async () => {},
              isBackgroundTask,
            },
          },
        )
        .then((result) => {
          settled = true;
          return result;
        });
      await waitFor(() => f.counts.wake === 1);
      await setImmediate();
      assert.equal(
        settled,
        false,
        'an enqueued job is not a completed tool result',
      );
      f.job().status = 'running';
      await setImmediate();
      assert.equal(settled, false);
      f.job().status = 'completed';
      if (name === 'backtest_optimize') {
        f.deps.config.engine = 'tushare';
        await assertFollowup(f);
        assert.equal(
          settled,
          false,
          'optimization completion must still wait for the ordinary backtest',
        );
        f.job().status = 'completed';
      }
      const result = await pending;
      assert.equal(result.run_id, result.run.id);
      assert.equal(result.run.status, 'completed');
      assert.equal(result.terminal, true);
      assert.deepEqual(result.result.metrics, metrics);
      if (name === 'backtest_optimize') {
        assert.equal(result.run.config.optimization.timeout_seconds, 0);
        assert.equal(result.backtest.run_id, f.job().id);
        assert.deepEqual(result.backtest.result.metrics, backtestMetrics);
      }
      assert.equal(f.counts.enqueue, name === 'backtest_optimize' ? 2 : 1);
      assert.equal(f.counts.cancel, 0);
    });
  }

  for (const outcome of [
    'foreground',
    'disabled',
    'completed',
    'deferred',
    'cancelled',
    'timed_out',
  ]) {
    test(`${name} native execution mode: ${outcome}`, async (t) => {
      const background = !['foreground', 'disabled'].includes(outcome);
      const completed = !['cancelled', 'timed_out'].includes(outcome);
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
                  // Foreground is the default; native background requires an explicit override.
                  input: JSON.stringify({
                    ...f.input,
                    ...(outcome === 'foreground'
                      ? {}
                      : {
                          _background:
                            outcome === 'deferred'
                              ? { disposition: 'deferred' }
                              : { enabled: background },
                        }),
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
      const storage = new InMemoryStore();
      const agent = new Agent({
        id: 'quant-test',
        name: 'Quant test',
        instructions: quantAgent.instructions,
        memory: new MockMemory({ storage, enableMessageHistory: true }),
        model,
        tools: { [tool.id]: tool },
      });
      const mastra = new Mastra({
        agents: { quant: agent },
        storage,
        logger: false,
        // If the tool forgets its own budget, this test times out before the worker completes.
        backgroundTasks: { enabled: true, defaultTimeoutMs: 50 },
      });
      t.after(() => mastra.shutdown());
      const controller = new AbortController();
      const output = await agent.stream('Run the backtest', {
        requestContext: f.requestContext,
        abortSignal: controller.signal,
        memory: { thread: 'quant-thread', resource: 'admin' },
        ...(background && completed ? { untilIdle: true } : {}),
      });
      const chunks: string[] = [];
      let streamFinished = false;
      const consuming = (async () => {
        for await (const chunk of output.fullStream) chunks.push(chunk.type);
        streamFinished = true;
      })();
      await waitFor(
        () =>
          f.counts.enqueue === 1 &&
          (!background || chunks.includes('background-task-started')),
      );
      assert.equal(f.counts.enqueue, 1);
      const manager = mastra.backgroundTaskManager!;
      const { tasks } = await manager.listTasks({ toolName: tool.id });
      if (!background) {
        await delay(80);
        assert.equal(tasks.length, 0);
        assert.equal(chunks.includes('background-task-started'), false);
        assert.equal(chunks.includes('tool-result'), false);
        assert.equal(
          streamFinished,
          false,
          'the tool call must block while the job runs',
        );
        assert.equal(
          calls,
          1,
          'the model cannot continue before the final result',
        );
        f.job().status = 'completed';
        if (name === 'backtest_optimize') {
          await assertFollowup(f);
          assert.equal(streamFinished, false);
          assert.equal(calls, 1);
          f.job().status = 'completed';
        }
        await consuming;
        assert.ok(chunks.includes('tool-result'));
        assert.equal(
          (await manager.listTasks({ toolName: tool.id })).tasks.length,
          0,
        );
        assert.ok(
          model.doStreamCalls.some((call) =>
            JSON.stringify(call.prompt).includes('"total_points":128'),
          ),
        );
        assert.equal(f.counts.enqueue, name === 'backtest_optimize' ? 2 : 1);
        return;
      }
      assert.ok(chunks.includes('background-task-started'));
      assert.equal(tasks.length, 1);
      const taskId = tasks[0].id;
      assert.equal(
        tasks[0].timeoutMs,
        outcome === 'timed_out' ? 1000 : BACKTEST_BACKGROUND_TIMEOUT_MS,
      );
      assert.equal(tasks[0].status, 'running');
      if (name === 'backtest_optimize' && outcome === 'cancelled') {
        f.job().status = 'completed';
        await assertFollowup(f);
        assert.equal((await manager.getTask(taskId))!.status, 'running');
      }
      if (!completed) controller.abort();
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
        if (name === 'backtest_optimize')
          assert.equal([...f.jobs.values()][0].status, 'completed');
      } else {
        f.job().status = 'completed';
        if (name === 'backtest_optimize') {
          await assertFollowup(f);
          assert.equal((await manager.getTask(taskId))!.status, 'running');
          assert.equal(chunks.includes('background-task-completed'), false);
          f.job().status = 'completed';
        }
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
          backtest?: {
            run_id: string;
            run: BacktestRun;
            result: { metrics: typeof backtestMetrics };
          };
        };
        assert.equal(report.run_id, [...f.jobs.keys()][0]);
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
          assert.equal(
            report.run.optimization_version_id,
            f.optimizedVersionId,
          );
          assert.equal(report.backtest!.run_id, f.job().id);
          assert.equal(report.backtest!.run.status, 'completed');
          assert.deepEqual(report.backtest!.result.metrics, backtestMetrics);
        } else assert.equal(report.optimization, null);
        await consuming;
        assert.ok(
          chunks.includes('background-task-completed'),
          JSON.stringify(chunks),
        );
        assert.ok(
          model.doStreamCalls.some((call) =>
            JSON.stringify(call.prompt).includes('"total_points":128'),
          ),
        );
        if (name === 'backtest_optimize')
          assert.ok(
            model.doStreamCalls.some((call) =>
              JSON.stringify(call.prompt).includes('"total_points":200'),
            ),
          );
      }
      await consuming;
      assert.equal(
        f.counts.enqueue,
        name === 'backtest_optimize' && (completed || outcome === 'cancelled')
          ? 2
          : 1,
      );
    });
  }
}

function optimizeInput(f: ReturnType<typeof fixture>) {
  return {
    ...f.input,
    optimization: {
      metric: 'total_points',
      search_space: { window: { type: 'int', low: 2, high: 5 } },
    },
  };
}

for (const status of ['failed', 'cancelled'] as const) {
  test(`unsuccessful optimization (${status}) does not enqueue an ordinary backtest`, async () => {
    const f = fixture();
    const pending = f.call('backtest_optimize', optimizeInput(f));
    await waitFor(() => f.counts.wake === 1);
    f.job().status = status;
    const result = await pending;
    assert.equal(result.run.status, status);
    assert.equal(result.backtest, undefined);
    assert.equal(f.counts.enqueue, 1);
  });
}

test('follow-up backtest failure preserves its record and the successful optimization', async () => {
  const f = fixture();
  const pending = f.call('backtest_optimize', optimizeInput(f));
  await waitFor(() => f.counts.wake === 1);
  f.job().status = 'completed';
  await assertFollowup(f);
  f.job().status = 'failed';
  f.job().message = '历史数据缺失';
  const result = await pending;
  assert.equal(result.run.status, 'completed');
  assert.deepEqual(
    result.optimization.best_parameters,
    optimization.best_parameters,
  );
  assert.equal(result.backtest.run_id, f.job().id);
  assert.equal(result.backtest.run.status, 'failed');
  assert.equal(result.backtest.message, '历史数据缺失');
  assert.equal(f.counts.enqueue, 2);
});

test('follow-up submission failure preserves optimization results without leaking infrastructure details', async () => {
  const f = fixture();
  const enqueue = f.deps.records.enqueue;
  f.deps.records.enqueue = async (...args) => {
    if (f.counts.enqueue === 1) throw new Error('database password=secret');
    return enqueue(...args);
  };
  const pending = f.call('backtest_optimize', optimizeInput(f));
  await waitFor(() => f.counts.wake === 1);
  f.job().status = 'completed';
  const result = await pending;
  assert.equal(result.run.optimization_version_id, f.optimizedVersionId);
  assert.deepEqual(
    result.optimization.best_parameters,
    optimization.best_parameters,
  );
  assert.equal(result.backtest.error, 'QUANT_SERVICE_UNAVAILABLE');
  assert.match(result.backtest.message, /回测提交失败/);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(f.counts.enqueue, 1);
});

test('follow-up result lookup failure retains both run IDs for recovery', async () => {
  const f = fixture();
  const pending = f.call('backtest_optimize', optimizeInput(f));
  await waitFor(() => f.counts.wake === 1);
  const optimizationId = f.job().id;
  f.job().status = 'completed';
  await assertFollowup(f);
  f.job().status = 'completed';
  f.deps.records.artifact = async () => {
    throw new Error('database password=secret');
  };
  const result = await pending;
  assert.equal(result.run_id, optimizationId);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.backtest.run_id, f.job().id);
  assert.equal(result.backtest.error, 'QUANT_SERVICE_UNAVAILABLE');
  assert.match(result.backtest.message, /回测结果暂不可用/);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(f.counts.enqueue, 2);
});

test('foreground abort during the follow-up backtest cancels only that run', async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = f.call(
    'backtest_optimize',
    optimizeInput(f),
    controller.signal,
  );
  await waitFor(() => f.counts.wake === 1);
  f.job().status = 'completed';
  await assertFollowup(f);
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.message, '用户中止了操作');
  assert.equal(f.job().status, 'cancelled');
  assert.equal([...f.jobs.values()][0].status, 'completed');
  assert.equal(f.counts.cancel, 1);
});

test('abort between optimization and the follow-up prevents a new backtest', async () => {
  const f = fixture();
  const controller = new AbortController();
  const version = f.deps.records.version;
  f.deps.records.version = async (...args) => {
    if (args[1] === f.optimizedVersionId) controller.abort();
    return version(...args);
  };
  const pending = f.call(
    'backtest_optimize',
    optimizeInput(f),
    controller.signal,
  );
  await waitFor(() => f.counts.wake === 1);
  f.job().status = 'completed';
  assert.equal((await pending).cancelled, true);
  await setImmediate();
  assert.equal(f.counts.enqueue, 1);
  assert.equal(f.counts.cancel, 0);
});

test('native cancellation settles immediately even while a status query is pending', async () => {
  const f = fixture();
  const controller = new AbortController();
  let release!: (run: BacktestRun) => void;
  f.deps.records.run = async () => {
    f.counts.read++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pending = f.call('backtest_start', f.input, controller.signal, {
    agent: {
      agentId: 'quant-test',
      toolCallId: 'test-call',
      messages: [],
      suspend: async () => {},
      isBackgroundTask: true,
    },
  });
  const rejected = assert.rejects(pending, /用户中止了操作/);
  await waitFor(() => f.counts.read === 1);
  controller.abort(new Error('用户中止了操作'));
  await rejected;
  release(f.job());
  await setImmediate();
  assert.equal(f.counts.cancel, 1);
  assert.equal(f.counts.read, 1);
});

test('status reads once by default and reports active and terminal states', async () => {
  const f = fixture();
  const started = await f.seed();
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
      run_id: started.id,
    });
    assert.equal(result.run.status, status);
    assert.equal(
      result.terminal,
      !['queued', 'preparing', 'running'].includes(status),
    );
    assert.equal(f.counts.read, 1);
  }
});

test('direct execution abort returns immediately and cancels the pending backtest', async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = f.call('backtest_start', f.input, controller.signal);
  await waitFor(() => f.counts.wake === 1);
  controller.abort();
  assert.deepEqual(await pending, {
    cancelled: true,
    message: '用户中止了操作',
  });
  assert.equal(f.counts.cancel, 1);
  assert.equal(f.job().status, 'cancelled');
});

test('aborting a pending status read returns immediately without cancelling the background task', async () => {
  const f = fixture();
  const started = await f.seed();
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
    { run_id: started.id },
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
