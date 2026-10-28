import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginContext } from '@app/plugin-sdk/server';
import type {
  FactorAnalysis,
  FactorAnalysisInput,
  FactorReport,
} from '../../factor-types.js';
import type { Bar } from '../../shared.js';
import type { MarketStore } from '../clickhouse.js';
import type { StateStore } from '../state-store.js';
import type { QuantConfig } from '../config.js';
import { ensurePython } from '../python.js';
import { runPython } from '../strategies/runner.js';
import { sha256 } from '../strategies/sources.js';
import { FactorError } from './schema.js';
import type { FactorStore } from './store.js';
import { writeFactorBundle } from './bundle.js';

export class FactorService {
  private active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  constructor(
    private context: PluginContext,
    private records: FactorStore,
    private market: {
      store: MarketStore;
      state: StateStore;
      config: QuantConfig;
    },
    private python = ensurePython,
  ) {}

  async stop() {
    const tasks = [...this.active.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.done));
  }

  private async isolated<T>(
    signal: AbortSignal,
    operation: (
      directory: string,
      python: string,
      signal: AbortSignal,
    ) => Promise<T>,
  ) {
    if (this.active.size >= 2)
      throw new FactorError('已有两个因子任务正在执行，请稍后重试', 429);
    const id = randomUUID();
    const controller = new AbortController();
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.active.set(id, { controller, done });
    const abort = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(600_000),
    ]);
    let directory: string | undefined;
    try {
      abort.throwIfAborted();
      const root = join(
        await this.context.runtime.ensureWorkspace(),
        'factor-runs',
      );
      await mkdir(root, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(root, 'run-'));
      const python = await this.python(this.context.runtime, abort);
      return await operation(directory, python, abort);
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        this.active.delete(id);
        complete();
      }
    }
  }

  async validate(
    source: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    await this.isolated(signal, async (directory, python, abort) => {
      await writeFactorBundle(this.records, source, directory);
      await writeFile(
        join(directory, 'input.json'),
        JSON.stringify({ source, parameters }),
        { mode: 0o600 },
      );
      await runPython(
        python,
        [
          join(
            this.context.runtime.paths.pluginRoot,
            'worker/factor_validate.py',
          ),
          join(this.context.runtime.paths.pluginRoot, 'sdk'),
          directory,
        ],
        directory,
        abort,
        30_000,
      );
    });
  }

  async analyze(
    actor: string,
    factorId: string,
    input: FactorAnalysisInput,
    signal: AbortSignal,
  ): Promise<FactorAnalysis> {
    const factor = await this.records.detail(factorId);
    if (!factor.enabled) throw new FactorError('请先启用因子');
    const version = input.version_id
      ? await this.records.version(input.version_id)
      : null;
    if (version && version.factor_id !== factorId)
      throw new FactorError('版本不属于当前因子');
    const { source, parameters } = version ?? factor;
    const run: FactorAnalysis = {
      id: randomUUID(),
      factor_id: factorId,
      config: input,
      source,
      parameters,
      source_hash: sha256(source),
      status: 'running',
      message: '读取日线行情并执行因子分析',
      created_at: new Date().toISOString(),
      finished_at: null,
      report: null,
    };
    return this.isolated(signal, async (directory, python, abort) => {
      await this.records.saveAnalysis(actor, run, 0);
      try {
        const bars: Bar[] = [];
        const start = Date.parse(`${input.start}T00:00:00+08:00`) / 1000;
        const end = Date.parse(`${input.end}T23:59:59+08:00`) / 1000;
        for (const symbol of input.symbols) {
          abort.throwIfAborted();
          const instrument = await this.market.state.instrument(
            this.market.config.engine,
            symbol,
          );
          if (
            !instrument ||
            !['future', 'continuous'].includes(instrument.kind) ||
            (instrument.kind === 'continuous' && !symbol.startsWith('KQ.m@'))
          )
            throw new FactorError(`暂时仅支持期货及主力连续合约：${symbol}`);
          // 500 prior observations support the maximum SDK lookback. Include night sessions.
          const warmup = await this.market.store.bars(
            this.market.config.engine,
            symbol,
            86400,
            { before: start - 3 * 86400, limit: 500, rebuildTicks: false },
          );
          bars.push(...warmup);
          let after = start - 3 * 86400 - 1;
          for (;;) {
            abort.throwIfAborted();
            const page = await this.market.store.bars(
              this.market.config.engine,
              symbol,
              86400,
              { after, before: end + 1, limit: 1000, rebuildTicks: false },
            );
            if (!page.length) break;
            bars.push(...page);
            if (bars.length > 250_000)
              throw new FactorError('行情超过 25 万条，请缩短区间或减少合约');
            const next = page.at(-1)!.time;
            if (next <= after) throw new FactorError('行情分页未前进');
            after = next;
            if (page.length < 1000) break;
          }
        }
        abort.throwIfAborted();
        await writeFactorBundle(this.records, source, directory);
        await writeFile(
          join(directory, 'input.json'),
          JSON.stringify({
            source,
            parameters,
            config: input,
            bars,
            now: Date.now() / 1000,
          }),
          { mode: 0o600 },
        );
        await runPython(
          python,
          [
            join(
              this.context.runtime.paths.pluginRoot,
              'worker/factor_analysis.py',
            ),
            join(this.context.runtime.paths.pluginRoot, 'sdk'),
            directory,
          ],
          directory,
          abort,
          180_000,
        );
        const file = await open(
          join(directory, 'result.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
            throw new FactorError('分析产物无效或超过 8 MiB');
          run.report = JSON.parse(await file.readFile('utf8')) as FactorReport;
        } finally {
          await file.close();
        }
        abort.throwIfAborted();
        run.status = 'completed';
        run.message = '因子分析完成';
      } catch (error) {
        run.status = abort.aborted ? 'cancelled' : 'failed';
        run.message = abort.aborted
          ? '用户中止了操作或任务已超时'
          : (error instanceof Error ? error.message : '分析失败').slice(
              0,
              1000,
            );
      }
      run.finished_at = new Date().toISOString();
      await this.records.saveAnalysis(actor, run, 1);
      return run;
    });
  }
}
