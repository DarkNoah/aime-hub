import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { PluginContext } from '@app/plugin-sdk/server';
import type { BacktestRun } from '../strategy-types.js';
import type { OptimizationReport } from '../optimization-types.js';
import { BacktestWorker } from '../server/strategies/runner.js';
import type { StrategyStore } from '../server/strategies/store.js';
import { input, start, actual } from './strategy-fixture.js';
import { optimizationSchema } from '../server/strategies/optimization.js';

const source = `from quant_sdk import Strategy
class Example(Strategy):
 def on_start(self, ctx): ctx.data.subscribe(ctx.params['symbol'], 60)
 def on_bar(self, ctx, bar):
  n = ctx.state.get('n', 0)
  ctx.state['n'] = n + 1
  if n == 0: ctx.orders.target_position(bar.symbol, ctx.params['size'])
  if n == 2: ctx.orders.target_position(bar.symbol, 0)
`;

for (const scenario of [
  'complete',
  'cancel',
  'heartbeat',
  'final-heartbeat',
] as const)
  test(
    `real Python worker persists optimization artifacts: ${scenario}`,
    {
      skip: !process.env.QUANT_OPTUNA_PYTHON,
      timeout: 20000,
    },
    async () => {
      const cancel = scenario === 'cancel';
      const transientHeartbeat = scenario === 'heartbeat';
      let heartbeatAttempts = 0;
      let draftsCreated = 0;
      let completedHeartbeat = false;
      const workspace = await mkdtemp(join(tmpdir(), 'optuna-worker-'));
      const artifacts = new Map<string, string>();
      const config = {
        ...input(randomUUID(), actual),
        end: start + 86400 + 300,
        parameters: { size: 1 },
        benchmark_symbol: null,
        optimization: optimizationSchema.parse({
          search_space: { size: { type: 'int', low: 1, high: 2 } },
          metric: 'total_return',
          n_trials: 2,
          validation_start: start + 86400,
        }),
      };
      let job: BacktestRun & { user_id: string } = {
        id: randomUUID(),
        user_id: 'alice',
        strategy_id: randomUUID(),
        version_id: config.version_id,
        version_number: 1,
        source_hash: 'hash',
        engine: 'tqsdk',
        status: 'queued',
        message: '',
        config,
        cancel_requested: false,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
      };
      let claimed = false;
      const records = {
        async claim() {
          if (claimed) return null;
          claimed = true;
          return job;
        },
        async version() {
          return {
            source: cancel
              ? "from pathlib import Path\nimport time\nif Path(__file__).parent.name != 'trial-0': time.sleep(30)\n" +
                source
              : transientHeartbeat
                ? 'import time\ntime.sleep(2)\n' + source
                : source,
          };
        },
        async heartbeat() {
          if (scenario === 'final-heartbeat' && job.status === 'completed') {
            completedHeartbeat = true;
            return false;
          }
          if (transientHeartbeat && ++heartbeatAttempts === 1)
            throw new Error('temporary database failure');
          return !job.cancel_requested;
        },
        async status(
          _id: string,
          _worker: string,
          status: BacktestRun['status'],
          message = '',
        ) {
          job = { ...job, status, message };
          if (scenario === 'final-heartbeat' && status === 'completed')
            await delay(2500);
        },
        async putArtifact(_id: string, kind: string, value: string) {
          assert.ok(!artifacts.has(kind));
          artifacts.set(kind, value);
        },
        async createOptimizationDraft(owner: string, runId: string) {
          assert.equal(owner, job.user_id);
          assert.equal(runId, job.id);
          assert.equal(job.status, 'completed');
          assert.ok(artifacts.has('optimization'));
          draftsCreated++;
        },
      } as unknown as StrategyStore;
      const market = {
        config: { engine: 'tqsdk' },
        state: {
          async instrument() {
            return { symbol: actual, kind: 'future', priceTick: 1 };
          },
        },
        store: {
          async bars() {
            return [0, 86400].flatMap((offset) =>
              [100, 100, 105, 110, 115].map((price, i) => ({
                symbol: actual,
                duration: 60,
                time: start + offset + i * 60,
                open: price,
                high: price + 1,
                low: price - 1,
                close: price,
                volume: 1000,
                amount: 0,
                openInterest: 0,
              })),
            );
          },
        },
      } as unknown as ConstructorParameters<typeof BacktestWorker>[2];
      const context = {
        assertEnabled: async () => {},
        runtime: {
          ensureWorkspace: async () => workspace,
          paths: { pluginRoot: resolve('plugins/vibe-quant') },
        },
      } as unknown as PluginContext;
      const worker = new BacktestWorker(
        context,
        records,
        market,
        async () => process.env.QUANT_OPTUNA_PYTHON!,
      );
      try {
        worker.start();
        const deadline = Date.now() + 18000;
        while (
          (!['completed', 'failed', 'cancelled'].includes(job.status) ||
            (job.status === 'completed' && draftsCreated === 0)) &&
          Date.now() < deadline
        ) {
          if (cancel && job.message.includes('2/2'))
            job.cancel_requested = true;
          await delay(100);
        }
        assert.equal(
          job.status,
          cancel ? 'cancelled' : 'completed',
          job.message,
        );
        const report = JSON.parse(
          artifacts.get('optimization')!,
        ) as OptimizationReport;
        assert.equal(report.status, job.status);
        assert.equal(draftsCreated, cancel ? 0 : 1);
        if (scenario === 'final-heartbeat') assert.ok(completedHeartbeat);
        if (transientHeartbeat) assert.ok(heartbeatAttempts >= 2);
        assert.ok(report.best_parameters);
        const result = JSON.parse(artifacts.get('result')!);
        const manifest = JSON.parse(artifacts.get('manifest')!);
        assert.equal(result.artifacts.storage, 'clickhouse');
        assert.deepEqual(manifest.params, report.best_parameters);
        assert.equal(result.metrics.total_return, report.best_value);
        assert.ok(artifacts.has('dataset'));
        assert.ok(artifacts.has('market'));
        if (!cancel) {
          assert.ok(artifacts.has('validation'));
          assert.equal(report.validation?.status, 'succeeded');
        }
      } finally {
        await worker.stop();
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
