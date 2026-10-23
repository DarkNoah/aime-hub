import { randomUUID } from 'node:crypto';
import type {
  BacktestInput,
  BacktestRun,
  ScriptDraft,
  StrategyDetail,
  StrategySummary,
  StrategyVersion,
} from '../../strategy-types.js';
import type { Engine } from '../../shared.js';
import { ClickHouseClient, ClickHouseError } from '../clickhouse-client.js';
import { StrategyError } from './schema.js';
import { sha256, StrategySources } from './sources.js';
import { decodeArtifact, encodeArtifact } from './artifacts.js';

export type StoredStrategy = StrategySummary & {
  user_id: string;
  draft_hash: string;
  draft_parameters: Record<string, unknown>;
  versions: Omit<StrategyVersion, 'source'>[];
};
export type StoredRun = BacktestRun & {
  user_id: string;
  worker_id: string | null;
  heartbeat_at: string | null;
};
type RecordRow = { payload: string; revision: string | number };
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
  revision: row.revision,
  version_count: row.version_count,
  updated_at: row.updated_at,
});
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

/** All durable strategy state lives in ClickHouse, including published versions and queue state. */
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

  private async record<T>(table: string, id: string, owner?: string) {
    const [row] = await this.rows<RecordRow>(
      `SELECT payload, revision FROM ${this.table(table)} FINAL WHERE id = {id:String}
       ${owner === undefined ? '' : 'AND userId = {owner:String}'}`,
      { id, ...(owner === undefined ? {} : { owner }) },
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

  async storedStrategy(id: string, owner?: string): Promise<StoredStrategy> {
    const row = await this.record<StoredStrategy>(
      'quant_strategies',
      id,
      owner,
    );
    if (!row) throw new StrategyError('STRATEGY_NOT_FOUND', 404);
    return row.value;
  }

  async list(owner: string): Promise<StrategySummary[]> {
    const rows = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_strategies')} FINAL WHERE userId = {owner:String}
       ORDER BY JSONExtractString(payload, 'updated_at') DESC, id`,
      { owner },
    );
    return rows.map((row) => summary(JSON.parse(row.payload)));
  }

  async detail(owner: string, id: string): Promise<StrategyDetail> {
    const row = await this.storedStrategy(id, owner);
    return {
      ...summary(row),
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
      draft: ScriptDraft;
    },
    id?: string,
    revision?: number,
  ) {
    const existing = id ? await this.storedStrategy(id, owner) : undefined;
    if (existing && existing.revision !== revision)
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    const hash = await this.sources.put(value.draft.source);
    const row: StoredStrategy = {
      id: id ?? randomUUID(),
      user_id: owner,
      name: value.name,
      description: value.description,
      enabled: value.enabled,
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

  async versions(owner: string, id: string): Promise<StrategyVersion[]> {
    const row = await this.storedStrategy(id, owner);
    const sources = await this.sources.readMany(
      row.versions.map((v) => v.source_hash),
    );
    return [...row.versions]
      .sort((a, b) => b.number - a.number)
      .map((version) => {
        const source = sources.get(version.source_hash);
        if (source === undefined)
          throw new Error('策略脚本不存在于 ClickHouse');
        return versionDetail(version, source);
      });
  }

  async version(owner: string, id: string): Promise<StrategyVersion> {
    const [row] = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_strategies')} FINAL
       WHERE userId = {owner:String} AND arrayExists(v -> JSONExtractString(v, 'id') = {id:String},
         JSONExtractArrayRaw(payload, 'versions')) LIMIT 1`,
      { owner, id },
    );
    const version =
      row &&
      (JSON.parse(row.payload) as StoredStrategy).versions.find(
        (v) => v.id === id,
      );
    if (!version) throw new StrategyError('VERSION_NOT_FOUND', 404);
    return versionDetail(version, await this.sources.read(version.source_hash));
  }

  async publish(owner: string, id: string, revision: number, note: string) {
    const row = await this.storedStrategy(id, owner);
    if (row.revision !== revision)
      throw new StrategyError('STRATEGY_CONFLICT', 409);
    const source = await this.sources.read(row.draft_hash);
    const version: Omit<StrategyVersion, 'source'> = {
      id: randomUUID(),
      strategy_id: id,
      number: row.version_count + 1,
      source_hash: row.draft_hash,
      parameters: row.draft_parameters,
      note,
      created_at: iso(),
    };
    // Versions and the revision counter publish together in a single row replacement.
    const next = {
      ...row,
      revision: revision + 1,
      version_count: version.number,
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
    const strategy = await this.storedStrategy(id, owner);
    if (!strategy.enabled) throw new StrategyError('STRATEGY_DISABLED', 409);
    const version = strategy.versions.find((v) => v.id === config.version_id);
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
      WHERE id = {strategy:String} AND userId = {owner:String} AND revision = {strategyRevision:UInt64}
      AND JSONExtractBool(payload, 'enabled'))
      AND (SELECT count() FROM ${this.table('quant_strategy_runs')} FINAL
        WHERE userId = {owner:String} AND ${activeSql}) < 3`;
    if (
      !(await this.replace('quant_strategy_runs', row, 0, condition, {
        strategy: id,
        strategyRevision: String(strategy.revision),
      }))
    ) {
      const current = await this.storedStrategy(id, owner);
      if (!current.enabled) throw new StrategyError('STRATEGY_DISABLED', 409);
      if (current.revision !== strategy.revision)
        throw new StrategyError('STRATEGY_CONFLICT', 409);
      throw new StrategyError('RUN_QUEUE_FULL', 429);
    }
    return row;
  }

  async runs(
    owner: string,
    id: string,
    before?: string,
  ): Promise<BacktestRun[]> {
    await this.storedStrategy(id, owner);
    const cursor = before
      ? await this.record<StoredRun>('quant_strategy_runs', before, owner)
      : undefined;
    if (before && (!cursor || cursor.value.strategy_id !== id)) return [];
    const rows = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_strategy_runs')} FINAL
       WHERE userId = {owner:String} AND JSONExtractString(payload, 'strategy_id') = {strategy:String}
       ${cursor ? "AND (JSONExtractString(payload, 'created_at'), id) < ({before:String}, {beforeId:String})" : ''}
       ORDER BY JSONExtractString(payload, 'created_at') DESC, id DESC LIMIT 30`,
      {
        owner,
        strategy: id,
        before: cursor?.value.created_at ?? '',
        beforeId: before ?? '',
      },
    );
    return rows.map((row) => JSON.parse(row.payload));
  }

  async run(owner: string, id: string): Promise<BacktestRun> {
    const row = await this.record<StoredRun>('quant_strategy_runs', id, owner);
    if (!row) throw new StrategyError('RUN_NOT_FOUND', 404);
    return row.value;
  }

  private async updateRun(
    id: string,
    update: (run: StoredRun) => StoredRun | undefined,
  ) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const row = await this.record<StoredRun>('quant_strategy_runs', id);
      if (!row) return;
      const next = update(row.value);
      if (!next) return;
      if (await this.replace('quant_strategy_runs', next, row.revision))
        return next;
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
