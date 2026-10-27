import type { SignalMonitor } from '../../signal-types.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  BacktestInput,
  BacktestRun,
  ScriptDraft,
  StrategyDetail,
  StrategySummary,
  StrategyStatus,
  StrategyVersion,
} from '../../strategy-types.js';
import type { Engine } from '../../shared.js';
import { ClickHouseClient, ClickHouseError } from '../clickhouse-client.js';
import { StrategyError } from './schema.js';
import { sha256, StrategySources } from './sources.js';
import { decodeArtifact, encodeArtifact } from './artifacts.js';
import type { OptimizationReport } from '../../optimization-types.js';
import {
  strategyNotifications,
  type StrategyNotifications,
} from '../../strategy-notifications.js';

export type StoredStrategy = Omit<StrategySummary, 'status'> & {
  /** Records saved before lifecycle support are active. */
  status?: StrategyStatus;
  /** Legacy records have no notification preferences; channels default to off. */
  notifications?: StrategyNotifications;
  /** Creator attribution only; strategies are shared across authenticated users. */
  user_id: string;
  draft_hash: string;
  draft_parameters: Record<string, unknown>;
  versions: StoredVersion[];
};
export type StoredRun = BacktestRun & {
  /** Submitter attribution and per-user queue limit, not an access boundary. */
  user_id: string;
  worker_id: string | null;
  heartbeat_at: string | null;
};
type RecordRow = { payload: string; revision: string | number };
type StoredVersion = Omit<StrategyVersion, 'source'> & { deleted_at?: string };
const runMetrics = (
  metrics?: Record<string, unknown>,
): NonNullable<BacktestRun['metrics']> => {
  const finite = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    profit_factor: finite(metrics?.profit_factor),
    sharpe: finite(metrics?.sharpe),
  };
};
const active = (run: BacktestRun) =>
  ['queued', 'preparing', 'running'].includes(run.status);
const iso = () => new Date().toISOString();
const activeSql =
  "JSONExtractString(payload, 'status') IN ('queued','preparing','running')";
const summary = (row: StoredStrategy): StrategySummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  enabled: row.enabled,
  status: row.status ?? 'active',
  revision: row.revision,
  version_count: row.version_count,
  updated_at: row.updated_at,
});
function assertEditable(row: StoredStrategy) {
  if (row.status === 'deleted')
    throw new StrategyError('STRATEGY_DELETED', 409);
  if (row.status === 'archived')
    throw new StrategyError('STRATEGY_ARCHIVED', 409);
}
// Project public fields explicitly without rewriting immutable legacy records.
const versionDetail = (
  version: Omit<StrategyVersion, 'source'>,
  source: string,
): StrategyVersion => ({
  id: version.id,
  strategy_id: version.strategy_id,
  number: version.number,
  source_hash: version.source_hash,
  parameters: version.parameters,
  note: version.note,
  created_at: version.created_at,
  source,
});

/** Shared strategy library in ClickHouse. Caller IDs attribute writes, not access. */
export class StrategyStore extends ClickHouseClient {
  get sources() {
    return new StrategySources(this.config);
  }

  async initialize() {
    await this.sources.initialize();
    for (const name of ['quant_strategies', 'quant_strategy_runs']) {
      await this.ensureTable(
        name,
        'id String, userId String, payload String CODEC(ZSTD(3)), revision UInt64',
        'ReplacingMergeTree(revision) ORDER BY id',
      );
    }
    await this.ensureTable(
      'quant_strategy_run_artifacts',
      'runId String, kind String, hash String, data String CODEC(ZSTD(3))',
      'ReplacingMergeTree ORDER BY (runId, kind)',
    );
    await this.ensureTable(
      'quant_strategy_migrations',
      'id String',
      'ReplacingMergeTree ORDER BY id',
    );
  }

  private async ensureTable(name: string, columns: string, engine: string) {
    try {
      await this.request(`SELECT * FROM ${this.table(name)} LIMIT 0`);
    } catch (error) {
      if (!(error instanceof ClickHouseError) || error.code !== 60) throw error;
      await this.request(
        `CREATE TABLE IF NOT EXISTS ${this.table(name)} (${columns}) ENGINE = ${engine}`,
      );
    }
  }

  private async record<T>(table: string, id: string) {
    const [row] = await this.rows<RecordRow>(
      `SELECT payload, revision FROM ${this.table(table)} FINAL WHERE id = {id:String}`,
      { id },
    );
    return row
      ? { value: JSON.parse(row.payload) as T, revision: Number(row.revision) }
      : undefined;
  }

  /** The revision comparison and replacement are ONE synchronous INSERT SELECT.
   * The shared query ID serializes only this statement on a single ClickHouse server;
   * it is never used as a lock spanning the preceding read and this write.
   */
  private async replace(
    table: string,
    value: { id: string; user_id: string },
    revision: number,
    condition = '1',
    params: Record<string, string> = {},
  ) {
    const match = `SELECT 1 FROM ${this.table(table)} FINAL WHERE id = {id:String}`;
    const result = await this.execute(
      `INSERT INTO ${this.table(table)}
       SELECT {id:String}, {owner:String}, payload, {next:UInt64}
       FROM input('payload String')
       WHERE ${revision === 0 ? `NOT EXISTS (${match})` : `EXISTS (${match} AND revision = {previous:UInt64})`}
         AND (${condition}) FORMAT JSONEachRow`,
      {
        ...params,
        id: value.id,
        owner: value.user_id,
        previous: String(revision),
        next: String(revision + 1),
      },
      JSON.stringify({ payload: JSON.stringify(value) }),
      'strategy-state',
    );
    return result.writtenRows === 1;
  }

  async storedStrategy(id: string): Promise<StoredStrategy> {
    const row = await this.record<StoredStrategy>('quant_strategies', id);
    if (!row) throw new StrategyError('STRATEGY_NOT_FOUND', 404);
    return row.value;
  }

  async list(
    _actor: string,
    status: StrategyStatus | 'all' = 'active',
  ): Promise<StrategySummary[]> {
    const rows = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_strategies')} FINAL
       ${status === 'all' ? '' : "WHERE if(JSONExtractString(payload, 'status') = '', 'active', JSONExtractString(payload, 'status')) = {status:String}"}
       ORDER BY JSONExtractString(payload, 'updated_at') DESC, id`,
      { status },
    );
    return rows.map((row) => summary(JSON.parse(row.payload)));
  }

  async setStatus(
    _actor: string,
    id: string,
    revision: number,
    status: StrategyStatus,
  ): Promise<StrategySummary> {
    const row = await this.storedStrategy(id);
    if (row.revision !== revision)
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    if ((row.status ?? 'active') === status) return summary(row);
    const next: StoredStrategy = {
      ...row,
      status,
      revision: revision + 1,
      updated_at: iso(),
    };
    if (!(await this.replace('quant_strategies', next, revision)))
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    return summary(next);
  }

  async detail(_actor: string, id: string): Promise<StrategyDetail> {
    const row = await this.storedStrategy(id);
    return {
      ...summary(row),
      notifications: strategyNotifications(row.notifications),
      draft: {
        source: await this.sources.read(row.draft_hash),
        parameters: row.draft_parameters,
      },
    };
  }

  async save(
    owner: string,
    value: {
      name: string;
      description: string;
      enabled: boolean;
      notifications?: StrategyNotifications;
      draft: ScriptDraft;
    },
    id?: string,
    revision?: number,
  ) {
    const existing = id ? await this.storedStrategy(id) : undefined;
    if (existing) assertEditable(existing);
    if (existing && existing.revision !== revision)
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    const hash = await this.sources.put(value.draft.source);
    const row: StoredStrategy = {
      id: id ?? randomUUID(),
      user_id: existing?.user_id ?? owner,
      name: value.name,
      description: value.description,
      enabled: value.enabled,
      notifications: strategyNotifications(
        value.notifications ?? existing?.notifications,
      ),
      status: 'active',
      revision: (existing?.revision ?? 0) + 1,
      version_count: existing?.version_count ?? 0,
      updated_at: iso(),
      draft_hash: hash,
      draft_parameters: value.draft.parameters,
      versions: existing?.versions ?? [],
    };
    if (!(await this.replace('quant_strategies', row, existing?.revision ?? 0)))
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    return this.detail(owner, row.id);
  }

  async versions(_actor: string, id: string): Promise<StrategyVersion[]> {
    const row = await this.storedStrategy(id);
    const versions = row.versions.filter((v) => !v.deleted_at);
    const sources = await this.sources.readMany(
      versions.map((v) => v.source_hash),
    );
    return versions
      .sort((a, b) => b.number - a.number)
      .map((version) => {
        const source = sources.get(version.source_hash);
        if (source === undefined)
          throw new Error('策略脚本不存在于 ClickHouse');
        return versionDetail(version, source);
      });
  }

  async version(
    _actor: string,
    id: string,
    includeDeleted = false,
  ): Promise<StrategyVersion> {
    const [row] = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_strategies')} FINAL
       WHERE arrayExists(v -> JSONExtractString(v, 'id') = {id:String},
         JSONExtractArrayRaw(payload, 'versions')) LIMIT 1`,
      { id },
    );
    const version =
      row &&
      (JSON.parse(row.payload) as StoredStrategy).versions.find(
        (v) => v.id === id,
      );
    if (!version || (version.deleted_at && !includeDeleted))
      throw new StrategyError('VERSION_NOT_FOUND', 404);
    return versionDetail(version, await this.sources.read(version.source_hash));
  }

  async deleteVersion(
    _actor: string,
    id: string,
    versionId: string,
    revision: number,
  ): Promise<StrategySummary> {
    const row = await this.storedStrategy(id);
    assertEditable(row);
    if (row.revision !== revision)
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    const version = row.versions.find(
      (v) => v.id === versionId && !v.deleted_at,
    );
    if (!version) throw new StrategyError('VERSION_NOT_FOUND', 404);
    const now = iso();
    const versions = row.versions.map((v) =>
      v.id === versionId ? { ...v, deleted_at: now } : v,
    );
    const next: StoredStrategy = {
      ...row,
      versions,
      version_count: versions.filter((v) => !v.deleted_at).length,
      revision: revision + 1,
      updated_at: now,
    };
    if (!(await this.replace('quant_strategies', next, revision)))
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    return summary(next);
  }

  async publish(owner: string, id: string, revision: number, note: string) {
    const row = await this.storedStrategy(id);
    assertEditable(row);
    if (row.revision !== revision)
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    const source = await this.sources.read(row.draft_hash);
    const version: Omit<StrategyVersion, 'source'> = {
      id: randomUUID(),
      strategy_id: id,
      number: row.versions.reduce((max, v) => Math.max(max, v.number), 0) + 1,
      source_hash: row.draft_hash,
      parameters: row.draft_parameters,
      note,
      created_at: iso(),
    };
    // Versions and the revision counter publish together in a single row replacement.
    const next = {
      ...row,
      revision: revision + 1,
      version_count: row.version_count + 1,
      updated_at: iso(),
      versions: [...row.versions, version],
    };
    if (!(await this.replace('quant_strategies', next, revision)))
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    return {
      strategy: await this.detail(owner, id),
      version: { ...version, source },
    };
  }

  async enqueue(
    owner: string,
    id: string,
    config: BacktestInput,
    engine: Engine,
  ) {
    const strategy = await this.storedStrategy(id);
    assertEditable(strategy);
    if (!strategy.enabled) throw new StrategyError('STRATEGY_DISABLED', 409);
    const version = strategy.versions.find(
      (v) => v.id === config.version_id && !v.deleted_at,
    );
    if (!version) throw new StrategyError('VERSION_NOT_FOUND', 404);
    const row: StoredRun = {
      id: randomUUID(),
      strategy_id: id,
      version_id: version.id,
      version_number: version.number,
      source_hash: version.source_hash,
      user_id: owner,
      engine,
      config: {
        ...config,
        parameters: { ...version.parameters, ...config.parameters },
      },
      status: 'queued',
      message: '',
      cancel_requested: false,
      worker_id: null,
      heartbeat_at: null,
      created_at: iso(),
      started_at: null,
      finished_at: null,
    };
    const condition = `EXISTS (SELECT 1 FROM ${this.table('quant_strategies')} FINAL
      WHERE id = {strategy:String} AND revision = {strategyRevision:UInt64}
      AND JSONExtractBool(payload, 'enabled')
      AND JSONExtractString(payload, 'status') IN ('', 'active'))
      AND (SELECT count() FROM ${this.table('quant_strategy_runs')} FINAL
        WHERE userId = {owner:String} AND ${activeSql}) < 3`;
    if (
      !(await this.replace('quant_strategy_runs', row, 0, condition, {
        strategy: id,
        strategyRevision: String(strategy.revision),
      }))
    ) {
      const current = await this.storedStrategy(id);
      assertEditable(current);
      if (!current.enabled) throw new StrategyError('STRATEGY_DISABLED', 409);
      if (current.revision !== strategy.revision)
        throw new StrategyError('STRATEGY_CONFLICT', 409);
      throw new StrategyError('RUN_QUEUE_FULL', 429);
    }
    return row;
  }

  async runs(
    _actor: string,
    id: string,
    before?: string,
    kind: 'backtest' | 'optimization' | 'all' = 'backtest',
    monitor?: Pick<SignalMonitor, 'engine' | 'config'>,
  ): Promise<BacktestRun[]> {
    await this.storedStrategy(id);
    const cursor = before
      ? await this.record<StoredRun>('quant_strategy_runs', before)
      : undefined;
    if (before && (!cursor || cursor.value.strategy_id !== id)) return [];
    const rows = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_strategy_runs')} FINAL
       WHERE JSONExtractString(payload, 'strategy_id') = {strategy:String}
       ${
         monitor
           ? `AND JSONExtractString(payload, 'version_id') = {version:String}
         AND JSONExtractString(payload, 'engine') = {engine:String}
         AND JSONExtractString(payload, 'config', 'symbol') = {symbol:String}
         AND JSONExtractUInt(payload, 'config', 'duration') = {duration:UInt32}`
           : ''
       }
       ${kind === 'all' ? '' : `AND ${kind === 'backtest' ? 'NOT ' : ''}JSONHas(payload, 'config', 'optimization')`}
       ${cursor ? "AND (JSONExtractString(payload, 'created_at'), id) < ({before:String}, {beforeId:String})" : ''}
       ORDER BY JSONExtractString(payload, 'created_at') DESC, id DESC LIMIT 30`,
      {
        strategy: id,
        ...(monitor
          ? {
              version: monitor.config.version_id,
              engine: monitor.engine,
              symbol: monitor.config.symbol,
              duration: String(monitor.config.duration),
            }
          : {}),
        before: cursor?.value.created_at ?? '',
        beforeId: before ?? '',
      },
    );
    const runs: BacktestRun[] = rows.map((row) => JSON.parse(row.payload));
    // Old results can be large: read one at a time, then persist the small summary
    // so subsequent polls do not repeatedly download and decompress artifacts.
    for (const run of runs) {
      if (run.status !== 'completed' || run.metrics !== undefined) continue;
      try {
        const result = await this.artifact(run.id, 'result');
        if (!result) continue;
        run.metrics = runMetrics(JSON.parse(result.text)?.metrics);
        await this.updateRun(run.id, (current) =>
          current.status === 'completed' && current.metrics === undefined
            ? { ...current, metrics: run.metrics }
            : undefined,
        );
      } catch (error) {
        // A missing/corrupt legacy result must not hide the entire run history.
        console.warn(
          '[vibe-quant] 回测列表指标暂不可用',
          run.id,
          error instanceof Error ? error.name : 'UnknownError',
        );
      }
    }
    return runs;
  }

  async run(_actor: string, id: string): Promise<BacktestRun> {
    const row = await this.record<StoredRun>('quant_strategy_runs', id);
    if (!row) throw new StrategyError('RUN_NOT_FOUND', 404);
    return row.value;
  }

  /** Reserve a target ID before insertion so retries/concurrent requests cannot clone twice. */
  async createOptimizationDraft(
    owner: string,
    id: string,
  ): Promise<StrategyDetail> {
    const run = await this.run(owner, id);
    if (
      !run.config.optimization ||
      run.status !== 'completed' ||
      run.cancel_requested
    )
      throw new StrategyError('OPTIMIZATION_NOT_COMPLETED', 409);
    const artifact = await this.artifact(id, 'optimization');
    const report =
      artifact && (JSON.parse(artifact.text) as OptimizationReport | null);
    if (
      !report ||
      report.status !== 'completed' ||
      !report.best_parameters ||
      typeof report.best_parameters !== 'object' ||
      Array.isArray(report.best_parameters) ||
      Object.keys(run.config.optimization.search_space).some(
        (key) => !Object.hasOwn(report.best_parameters!, key),
      )
    )
      throw new StrategyError('OPTIMIZATION_RESULT_MISSING', 409);
    const version = await this.version(owner, run.version_id, true);
    if (version.source_hash !== run.source_hash)
      throw new Error('策略版本哈希不匹配');
    const original = await this.storedStrategy(run.strategy_id);
    await this.updateRun(id, (current) =>
      current.status === 'completed' && !current.optimization_draft_id
        ? { ...current, optimization_draft_id: randomUUID() }
        : undefined,
    );
    const linked = await this.run(owner, id);
    const draftId = linked.optimization_draft_id;
    if (!draftId) throw new StrategyError('OPTIMIZATION_NOT_COMPLETED', 409);
    const existing = await this.record<StoredStrategy>(
      'quant_strategies',
      draftId,
    );
    if (existing) return this.detail(owner, draftId);
    const parameters = { ...version.parameters, ...run.config.parameters };
    for (const key of Object.keys(run.config.optimization.search_space))
      parameters[key] = report.best_parameters[key];
    const row: StoredStrategy = {
      id: draftId,
      user_id: owner,
      name: `${original.name.split(' · ')[0].slice(0, 120)} · 调优草稿`,
      description: `基于「${original.name}」v${version.number} 的 Optuna 调优草稿。\n目标：${report.metric}，最佳值 ${report.best_value}；有效试验 ${report.completed_trials}/${report.requested_trials}。\n${report.validation ? `留出验证：${report.validation.status}，目标值 ${report.validation.metrics[report.metric] ?? '未定义'}。` : '仅样本内搜索，尚未做留出验证。'}\n来源任务：${id}。源码保留所选版本，尚未发布。`,
      enabled: true,
      status: 'active',
      revision: 1,
      version_count: 0,
      updated_at: iso(),
      draft_hash: version.source_hash,
      draft_parameters: parameters,
      versions: [],
    };
    await this.replace('quant_strategies', row, 0);
    return this.detail(owner, draftId);
  }

  private async updateRun(
    id: string,
    update: (run: StoredRun) => StoredRun | undefined,
  ) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const row = await this.record<StoredRun>('quant_strategy_runs', id);
        if (!row) return;
        const next = update(row.value);
        if (!next) return;
        if (await this.replace('quant_strategy_runs', next, row.revision))
          return next;
      } catch (error) {
        // Read/CAS retry is safe even if a timed-out statement committed: the
        // next attempt reloads the latest row and rechecks worker ownership/status.
        if (
          attempt === 29 ||
          !(
            (error instanceof ClickHouseError && error.code === 241) ||
            (error instanceof Error && error.name === 'TimeoutError')
          )
        )
          throw error;
        await delay(Math.min(attempt + 1, 4) * 250);
      }
    }
    throw new Error('回测状态并发更新繁忙，请重试');
  }

  async cancel(owner: string, id: string) {
    await this.run(owner, id);
    await this.updateRun(id, (run) =>
      !active(run)
        ? undefined
        : {
            ...run,
            cancel_requested: true,
            ...(run.status === 'queued'
              ? {
                  status: 'cancelled' as const,
                  message: '用户中止了操作',
                  finished_at: iso(),
                }
              : {}),
          },
    );
    return this.run(owner, id);
  }

  async claim(worker: string): Promise<StoredRun | undefined> {
    const stale = await this.rows<{ id: string }>(
      `SELECT id FROM ${this.table('quant_strategy_runs')} FINAL
       WHERE JSONExtractString(payload, 'status') IN ('preparing','running')
       AND parseDateTime64BestEffortOrNull(JSONExtractString(payload, 'heartbeat_at')) < now64(3) - INTERVAL 90 SECOND`,
    );
    for (const row of stale)
      await this.updateRun(row.id, (run) =>
        ['preparing', 'running'].includes(run.status) &&
        run.heartbeat_at &&
        Date.parse(run.heartbeat_at) < Date.now() - 90_000
          ? {
              ...run,
              status: 'failed',
              message: '执行进程中断，请重新创建回测',
              finished_at: iso(),
            }
          : undefined,
      );
    for (let attempt = 0; attempt < 10; attempt++) {
      const [row] = await this.rows<{ id: string }>(
        `SELECT id FROM ${this.table('quant_strategy_runs')} FINAL
         WHERE JSONExtractString(payload, 'status') = 'queued' AND NOT JSONExtractBool(payload, 'cancel_requested')
         AND JSONExtractString(payload, 'engine') = {engine:String}
         ORDER BY JSONExtractString(payload, 'created_at'), id LIMIT 1`,
        { engine: this.config.engine },
      );
      if (!row) return;
      const claimed = await this.updateRun(row.id, (run) =>
        run.status !== 'queued' || run.cancel_requested
          ? undefined
          : {
              ...run,
              status: 'preparing',
              worker_id: worker,
              heartbeat_at: iso(),
              started_at: iso(),
            },
      );
      if (claimed) return claimed;
    }
  }

  async heartbeat(id: string, worker: string) {
    return !!(await this.updateRun(id, (run) =>
      run.worker_id === worker &&
      ['preparing', 'running'].includes(run.status) &&
      !run.cancel_requested
        ? { ...run, heartbeat_at: iso() }
        : undefined,
    ));
  }

  async status(
    id: string,
    worker: string,
    status: BacktestRun['status'],
    message = '',
    metrics?: Record<string, unknown>,
  ) {
    await this.updateRun(id, (run) => {
      if (
        run.worker_id !== worker ||
        !['preparing', 'running'].includes(run.status)
      )
        return;
      const cancelled =
        run.cancel_requested && ['completed', 'failed'].includes(status);
      return {
        ...run,
        status: cancelled ? 'cancelled' : status,
        ...(status === 'completed' && !cancelled && metrics
          ? { metrics: runMetrics(metrics) }
          : {}),
        message: cancelled ? '用户中止了操作' : message.slice(0, 2000),
        finished_at: ['completed', 'failed', 'cancelled'].includes(status)
          ? iso()
          : null,
      };
    });
  }

  async putArtifact(id: string, kind: string, value: string) {
    const encoded = await encodeArtifact(value);
    const hash = sha256(value);
    await this.execute(
      `INSERT INTO ${this.table('quant_strategy_run_artifacts')}
       SELECT {id:String}, {kind:String}, {hash:String}, data FROM input('data String')
       WHERE NOT EXISTS (SELECT 1 FROM ${this.table('quant_strategy_run_artifacts')} FINAL
         WHERE runId = {id:String} AND kind = {kind:String})
       SETTINGS max_threads=1, max_insert_threads=1, input_format_parallel_parsing=0 FORMAT JSONEachRow`,
      { id, kind, hash },
      JSON.stringify({ data: encoded }),
      'strategy-state',
    );
    const [stored] = await this.rows<{ hash: string }>(
      `SELECT hash FROM ${this.table('quant_strategy_run_artifacts')} FINAL WHERE runId = {id:String} AND kind = {kind:String}`,
      { id, kind },
    );
    if (stored?.hash !== hash) throw new Error('回测产物内容冲突');
    return hash;
  }

  async artifact(
    id: string,
    kind: string,
  ): Promise<{ hash: string; text: string } | null> {
    const [row] = await this.rows<{ hash: string; data: string }>(
      `SELECT hash, data FROM ${this.table('quant_strategy_run_artifacts')} FINAL WHERE runId = {id:String} AND kind = {kind:String} SETTINGS max_threads=1`,
      { id, kind },
    );
    if (!row) return null;
    const text = await decodeArtifact(row.data);
    if (sha256(text) !== row.hash) throw new Error('回测产物校验失败');
    return { hash: row.hash, text };
  }

  async importStrategy(row: StoredStrategy) {
    // Import preserves the public revision; subsequent CAS uses the same revision column.
    const result = await this.execute(
      `INSERT INTO ${this.table('quant_strategies')}
       SELECT {id:String}, {owner:String}, payload, {revision:UInt64} FROM input('payload String')
       WHERE NOT EXISTS (SELECT 1 FROM ${this.table('quant_strategies')} FINAL WHERE id = {id:String}) FORMAT JSONEachRow`,
      { id: row.id, owner: row.user_id, revision: String(row.revision) },
      JSON.stringify({ payload: JSON.stringify(row) }),
      'strategy-state',
    );
    const saved = await this.storedStrategy(row.id);
    if (
      saved.user_id !== row.user_id ||
      (result.writtenRows && JSON.stringify(saved) !== JSON.stringify(row))
    )
      throw new Error('策略迁移校验失败');
  }

  async importRun(row: StoredRun) {
    const inserted = await this.replace('quant_strategy_runs', row, 0);
    const saved = await this.record<StoredRun>('quant_strategy_runs', row.id);
    if (
      !saved ||
      saved.value.user_id !== row.user_id ||
      (inserted && JSON.stringify(saved.value) !== JSON.stringify(row))
    )
      throw new Error('回测记录迁移校验失败');
  }
}
