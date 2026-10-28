import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { PluginContext } from '@app/plugin-sdk/server';
import type { BacktestResult, BacktestRun } from '../../strategy-types.js';
import type { OptimizationReport } from '../../optimization-types.js';
import type { QuantConfig } from '../config.js';
import type { MarketStore } from '../clickhouse.js';
import type { StateStore } from '../state-store.js';
import { ensurePython } from '../python.js';
import { ClickHouseError } from '../clickhouse-client.js';
import { collectSnapshot } from './snapshot.js';
import { StrategyStore } from './store.js';
import { MAX_ARTIFACT_BYTES } from './limits.js';

class HeartbeatError extends Error {
  constructor() {
    super('数据库心跳持续失败，回测已停止；已保留完成的试验');
  }
}

/** Process isolation and cancellation, NOT a security sandbox. Only admins may enqueue code. */
export function runPython(
  python: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeout = 300_000,
  privateInput?: { tqUser: string; tqPassword: string },
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', '-u', ...args], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: [privateInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // No provider credentials, database URL, session cookie or host environment inheritance.
      env: {
        PATH: `${dirname(python)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        ...(isAbsolute(python)
          ? { VIRTUAL_ENV: dirname(dirname(python)) }
          : {}),
        HOME: cwd,
        TMPDIR: cwd,
        PYTHONNOUSERSITE: '1',
        PYTHONIOENCODING: 'utf-8',
        ...(process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
    });
    // Credentials travel only over an anonymous pipe, never argv, env, or artifacts.
    child.stdin?.on('error', () => {
      /* Early process failure is handled by close. */
    });
    if (privateInput) child.stdin?.end(JSON.stringify(privateInput));
    let stderr = '';
    let timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') child.kill(kind);
        else if (child.pid) process.kill(-child.pid, kind);
      } catch {
        /* Already exited. */
      }
    };
    const stop = () => {
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 1500);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', () => {
      /* Drain script output without storing unbounded logs. */
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (privateInput)
        for (const secret of Object.values(privateInput))
          if (secret) stderr = stderr.split(secret).join('[redacted]');
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener('abort', stop);
      kill('SIGKILL'); // Do not leave script-created children after a normal parent exit.
      if (signal.aborted) reject(new Error('用户中止了操作'));
      else if (timedOut)
        reject(
          new Error(
            `回测超过 ${Math.ceil(timeout / 60_000)} 分钟执行上限，请缩短区间`,
          ),
        );
      else if (code !== 0)
        reject(
          new Error(stderr.trim().split('\n').at(-1) || 'Python 执行失败'),
        );
      else resolve();
    });
  });
}
async function readArtifact(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES)
      throw new Error('回测产物无效或超过 128 MiB');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
export class BacktestWorker {
  private id = randomUUID();
  private timer?: ReturnType<typeof setTimeout>;
  private task?: Promise<void>;
  private current?: AbortController;
  private stopped = true;
  constructor(
    private context: PluginContext,
    private records: StrategyStore,
    private market: {
      config: QuantConfig;
      store: MarketStore;
      state: StateStore;
    },
    private preparePython = ensurePython,
  ) {}
  start() {
    this.stopped = false;
    this.wake();
  }
  wake() {
    if (this.stopped || this.task) return;
    clearTimeout(this.timer);
    this.task = this.tick()
      .catch(() => {
        /* Persisted queue survives a temporary database failure. */
      })
      .finally(() => {
        this.task = undefined;
        if (!this.stopped) this.timer = setTimeout(() => this.wake(), 2000);
      });
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.current?.abort();
    await this.task;
  }
  private async tick() {
    await this.context.assertEnabled();
    const job = await this.records.claim(this.id);
    if (!job) return;
    const abort = new AbortController();
    this.current = abort;
    if (this.stopped) abort.abort();
    let heartbeatBusy = false;
    let confirmedAt = Date.now();
    const timer = setInterval(async () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        if (!(await this.records.heartbeat(job.id, this.id))) abort.abort();
        else confirmedAt = Date.now();
      } catch {
        // A transient memory/query failure is not a user cancellation. Retry
        // within the 90-second lease, then stop before another worker can claim it.
        if (Date.now() - confirmedAt >= 60_000)
          abort.abort(new HeartbeatError());
      } finally {
        heartbeatBusy = false;
      }
    }, 2000);
    try {
      await this.execute(job, abort.signal);
    } catch (error) {
      await this.records.status(
        job.id,
        this.id,
        abort.signal.aborted && !(abort.signal.reason instanceof HeartbeatError)
          ? 'cancelled'
          : 'failed',
        abort.signal.reason instanceof HeartbeatError
          ? abort.signal.reason.message
          : abort.signal.aborted
            ? this.stopped
              ? '插件停止，运行已中止'
              : '用户中止了操作'
            : error instanceof Error
              ? error.message
              : '回测失败',
      );
    } finally {
      clearInterval(timer);
      this.current = undefined;
    }
  }
  private async execute(
    job: BacktestRun & { user_id: string },
    signal: AbortSignal,
  ) {
    const native = job.config.backtest_engine === 'tqsdk';
    if (!native && job.engine !== this.market.config.engine)
      throw new Error('数据引擎已变更，请重新创建回测');
    signal.throwIfAborted();
    const version = await this.records.version(
      job.user_id,
      job.version_id,
      true,
    );
    const root = await this.context.runtime.ensureWorkspace();
    const work = join(root, 'strategy-runs');
    await mkdir(work, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(work, `${job.id}-`));
    let stage = '初始化 Python';
    try {
      const python = await this.preparePython(this.context.runtime, signal);
      const sdk = join(directory, 'sdk');
      await cp(
        join(this.context.runtime.paths.pluginRoot, 'sdk/quant_sdk'),
        join(sdk, 'quant_sdk'),
        { recursive: true, filter: (path) => !path.includes('__pycache__') },
      );
      if (native) {
        if (!this.market.config.tqUser || !this.market.config.tqPassword)
          throw new Error('请先在插件设置中配置天勤账号和密码');
        await writeFile(
          join(directory, 'config.json'),
          JSON.stringify(job.config),
          { mode: 0o600 },
        );
      } else {
        stage = '读取历史行情';
        const raw = await collectSnapshot(
          this.market.store,
          this.market.state,
          job.engine,
          job.config,
          signal,
        );
        stage = '保存原始行情快照';
        await this.records.putArtifact(job.id, 'market', JSON.stringify(raw));
        await writeFile(join(directory, 'market.json'), JSON.stringify(raw), {
          mode: 0o600,
        });
        await runPython(
          python,
          [
            join(
              this.context.runtime.paths.pluginRoot,
              'worker/strategy_prepare.py',
            ),
            sdk,
            join(directory, 'market.json'),
            join(directory, 'dataset.json'),
          ],
          directory,
          signal,
        );
        stage = '保存 SDK 数据快照';
        await this.records.putArtifact(
          job.id,
          'dataset',
          await readArtifact(join(directory, 'dataset.json')),
        );
        const {
          initial_cash,
          start,
          end,
          slippage_ticks,
          participation_rate,
          annualization,
          risk_free_rate,
          benchmark_symbol,
        } = job.config;
        await writeFile(
          join(directory, 'config.json'),
          JSON.stringify({
            initial_cash,
            pnl_mode:
              job.config.execution_model === 'points' ? 'points' : 'currency',
            point_cost: job.config.point_cost ?? 0,
            start,
            end,
            slippage_ticks,
            participation_rate,
            annualization,
            risk_free_rate,
            benchmark_symbol,
            ...(job.config.optimization
              ? { optimization: job.config.optimization }
              : {}),
            parameters: {
              ...job.config.parameters,
              symbol: job.config.symbol,
              duration: job.config.duration,
              execution_model: job.config.execution_model ?? 'actual_contract',
            },
          }),
          { mode: 0o600 },
        );
      }
      await writeFile(join(directory, 'strategy.py'), version.source, {
        mode: 0o600,
      });
      await this.records.prepareFactors(version.source, directory);
      signal.throwIfAborted();
      stage = '执行策略';
      await this.records.status(job.id, this.id, 'running');
      const optimizing = !!job.config.optimization;
      let progressTask: Promise<void> | undefined;
      let lastMessage = '';
      const progress = optimizing
        ? setInterval(() => {
            if (progressTask || signal.aborted) return;
            progressTask = (async () => {
              const report = JSON.parse(
                await readArtifact(join(directory, 'optimization.json')),
              ) as OptimizationReport;
              if (report.message !== lastMessage) {
                await this.records.status(
                  job.id,
                  this.id,
                  'running',
                  report.message,
                );
                lastMessage = report.message;
              }
            })()
              .catch(() => {
                /* The first atomic progress file may not exist yet. */
              })
              .finally(() => {
                progressTask = undefined;
              });
          }, 2000)
        : undefined;
      let executionError: unknown;
      try {
        await runPython(
          python,
          [
            join(
              this.context.runtime.paths.pluginRoot,
              native
                ? 'worker/strategy_tq.py'
                : optimizing
                  ? 'worker/strategy_optimize.py'
                  : 'worker/strategy_run.py',
            ),
            sdk,
            directory,
          ],
          directory,
          signal,
          optimizing
            ? (job.config.optimization!.timeout_seconds + 310) * 1000
            : native
              ? 900_000
              : 300_000,
          native
            ? {
                tqUser: this.market.config.tqUser,
                tqPassword: this.market.config.tqPassword,
              }
            : undefined,
        );
      } catch (error) {
        executionError = error;
      } finally {
        clearInterval(progress);
        await progressTask;
      }
      let optimization: OptimizationReport | undefined;
      if (optimizing) {
        const text = await readArtifact(
          join(directory, 'optimization.json'),
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (text) {
          optimization = JSON.parse(text) as OptimizationReport;
          if (signal.aborted || executionError) {
            optimization.status =
              signal.aborted && !(signal.reason instanceof HeartbeatError)
                ? 'cancelled'
                : 'failed';
            optimization.message =
              signal.reason instanceof HeartbeatError
                ? signal.reason.message
                : signal.aborted
                  ? '用户中止了操作；已保留完成的试验'
                  : '调参进程异常结束；已保留完成的试验';
          }
          await this.records.putArtifact(
            job.id,
            'optimization',
            JSON.stringify(optimization),
          );
          const validation = await readArtifact(
            join(directory, 'validation.json'),
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (validation)
            await this.records.putArtifact(job.id, 'validation', validation);
        }
      }
      if (executionError && !optimization) throw executionError;
      if (native) {
        stage = '保存天勤历史行情快照';
        await this.records.putArtifact(
          job.id,
          'dataset',
          await readArtifact(join(directory, 'dataset.json')),
        );
      }
      if (optimization && optimization.best_trial === null) {
        await this.records.status(
          job.id,
          this.id,
          optimization.status === 'cancelled' ? 'cancelled' : 'failed',
          optimization.message,
        );
        return;
      }
      if (
        optimization &&
        !/^[a-f0-9]{32}$/.test(optimization.best_run_id ?? '')
      )
        throw new Error('调参返回了无效的最佳试验 ID');
      const resultText = await readArtifact(
        optimization
          ? join(
              directory,
              'artifacts',
              optimization.best_run_id!,
              'result.json',
            )
          : join(directory, 'result.json'),
      );
      const result = JSON.parse(resultText) as BacktestResult;
      if (
        !result.metrics ||
        !Array.isArray(result.trades) ||
        !Array.isArray(result.equity_curve) ||
        !['succeeded', 'failed', 'cancelled'].includes(result.status) ||
        !/^[a-f0-9]{32}$/.test(result.run_id)
      )
        throw new Error('SDK 返回了无效结果');
      stage = '保存回测结果';
      await this.records.putArtifact(
        job.id,
        'result',
        JSON.stringify({
          ...result,
          artifacts: { storage: 'clickhouse', run_id: job.id },
        }),
      );
      const manifest = await readArtifact(
        join(directory, 'artifacts', result.run_id, 'manifest.json'),
      );
      await this.records.putArtifact(job.id, 'manifest', manifest);
      await this.records.status(
        job.id,
        this.id,
        optimization
          ? optimization.status === 'running'
            ? 'failed'
            : optimization.status
          : result.status === 'succeeded'
            ? 'completed'
            : (result.status as BacktestRun['status']),
        optimization?.message ?? result.message,
        result.metrics,
      );
      // A final heartbeat may observe the completed status and abort the lease.
      // Draft creation checks durable completion/cancellation itself.
      if (optimization?.status === 'completed')
        await this.records.createOptimizationDraft(job.user_id, job.id);
    } catch (error) {
      if (error instanceof ClickHouseError)
        throw new Error(
          `${stage}失败：ClickHouse HTTP ${error.status} / Code ${error.code}`,
        );
      throw error;
    } finally {
      // Durable inputs/results live in ClickHouse; temporary workspace copies have no long-term identity.
      await rm(directory, { recursive: true, force: true });
    }
  }
}
