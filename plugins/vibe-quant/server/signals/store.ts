import { SignalHistoryStore } from './history.js';
import { monitorExecutionModel } from '../../signal-types.js';
import { randomUUID } from 'node:crypto';
import type {
  SignalMonitor,
  SignalMonitorInput,
  StrategySignal,
  SignalOverlay,
} from '../../signal-types.js';
import type { Engine } from '../../shared.js';
import {
  ClickHouseClient,
  ClickHouseError,
  timeSql,
  versionSql,
} from '../clickhouse-client.js';
import { StrategyError } from '../strategies/schema.js';

export type StoredMonitor = Omit<SignalMonitor, 'status' | 'message'> & {
  user_id: string;
  deleted: boolean;
  history_cleared?: boolean;
};
export type MonitorRuntime = {
  ownerId: string;
  active: boolean;
  status: SignalMonitor['status'];
  message: string;
  checkpoint: string;
};
export class MonitorStore extends ClickHouseClient {
  get history() {
    return new SignalHistoryStore(this.config);
  }
  async initialize() {
    const tables = {
      quant_signal_monitors: [
        'id String, userId String, payload String, revision UInt64',
        'revision',
        'id',
      ],
      quant_signal_runtime: [
        'id String, ownerId String, expiresAt Float64, status String, message String, version UInt64',
        'version',
        'id',
      ],
      quant_signal_checkpoints: [
        'id String, checkpoint String CODEC(ZSTD(3)), version UInt64',
        'version',
        'id',
      ],
      quant_signal_overlays: [
        'id String, payload String CODEC(ZSTD(3)), version UInt64',
        'version',
        'id',
      ],
      quant_signal_events: [
        'id String, monitorId String, userId String, time Float64, payload String, version UInt64',
        'version',
        '(monitorId, id)',
      ],
    };
    for (const [name, [fields, version, key]] of Object.entries(tables)) {
      try {
        await this.request(`SELECT * FROM ${this.table(name)} LIMIT 0`);
      } catch (error) {
        if (!(error instanceof ClickHouseError) || error.code !== 60)
          throw error;
        await this.request(
          `CREATE TABLE IF NOT EXISTS ${this.table(name)} (${fields}) ENGINE = ReplacingMergeTree(${version}) ORDER BY ${key}`,
        );
      }
    }
    await this.history.initialize();
  }
  async get(id: string, owner?: string) {
    const [row] = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_signal_monitors')} FINAL WHERE id={id:String} ${owner ? 'AND userId={owner:String}' : ''}`,
      { id, ...(owner ? { owner } : {}) },
    );
    if (!row) throw new StrategyError('MONITOR_NOT_FOUND', 404);
    return JSON.parse(row.payload) as StoredMonitor;
  }
  async list(owner?: string, strategy?: string): Promise<StoredMonitor[]> {
    const rows = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_signal_monitors')} FINAL WHERE NOT JSONExtractBool(payload,'deleted') ${owner ? 'AND userId={owner:String}' : ''} ${strategy ? "AND JSONExtractString(payload,'strategy_id')={strategy:String}" : ''}`,
      { ...(owner ? { owner } : {}), ...(strategy ? { strategy } : {}) },
    );
    return rows.map((row) => JSON.parse(row.payload));
  }
  async runtime(id: string, includeCheckpoint = false) {
    const [row] = await this.rows<MonitorRuntime>(
      `SELECT ownerId, expiresAt > ${timeSql} AS active, status, message, ${includeCheckpoint ? `(SELECT any(checkpoint) FROM ${this.table('quant_signal_checkpoints')} FINAL WHERE id={id:String}) AS checkpoint` : "'' AS checkpoint"} FROM ${this.table('quant_signal_runtime')} FINAL WHERE id={id:String}`,
      { id },
    );
    return row;
  }
  async view(row: StoredMonitor): Promise<SignalMonitor> {
    const runtime = await this.runtime(row.id);
    return {
      id: row.id,
      strategy_id: row.strategy_id,
      version_number: row.version_number,
      engine: row.engine,
      config: {
        ...row.config,
        execution_model: monitorExecutionModel(row.config),
      },
      enabled: row.enabled,
      notifications_enabled: row.notifications_enabled ?? true,
      notifications: row.notifications,
      revision: row.revision,
      updated_at: row.updated_at,
      status: !row.enabled
        ? 'paused'
        : runtime?.active
          ? runtime.status
          : runtime?.status === 'error' || runtime?.status === 'paused'
            ? runtime.status
            : 'starting',
      message: !row.enabled ? '已暂停' : (runtime?.message ?? '等待后台启动'),
    };
  }
  async create(
    owner: string,
    strategy_id: string,
    version_number: number,
    engine: Engine,
    config: SignalMonitorInput,
    notificationOptions: Pick<
      SignalMonitor,
      'notifications' | 'notifications_enabled'
    > = {},
  ) {
    const row: StoredMonitor = {
      id: randomUUID(),
      user_id: owner,
      strategy_id,
      version_number,
      engine,
      config: { ...config, execution_model: monitorExecutionModel(config) },
      enabled: true,
      ...notificationOptions,
      deleted: false,
      revision: 1,
      updated_at: new Date().toISOString(),
    };
    const result = await this.execute(
      `INSERT INTO ${this.table('quant_signal_monitors')}
      SELECT {id:String}, {owner:String}, payload, 1 FROM input('payload String')
      WHERE (SELECT count() FROM ${this.table('quant_signal_monitors')} FINAL WHERE userId={owner:String} AND NOT JSONExtractBool(payload,'deleted')) < 8 FORMAT JSONEachRow`,
      { id: row.id, owner },
      JSON.stringify({ payload: JSON.stringify(row) }),
      'signal-monitor-config',
    );
    if (!result.writtenRows) throw new StrategyError('MONITOR_LIMIT', 429);
    return this.view(row);
  }
  async update(
    owner: string,
    id: string,
    revision: number,
    enabled: boolean,
    deleted = false,
    notificationOptions: Pick<
      SignalMonitor,
      'notifications' | 'notifications_enabled'
    > = {},
  ) {
    const previous = await this.get(id, owner);
    if (previous.deleted) {
      if (deleted) return this.view(await this.finishDelete(previous));
      throw new StrategyError('MONITOR_NOT_FOUND', 404);
    }
    if (previous.revision !== revision)
      throw new StrategyError('MONITOR_CONFLICT', 409);
    const row = {
      ...previous,
      ...notificationOptions,
      enabled,
      deleted,
      revision: revision + 1,
      updated_at: new Date().toISOString(),
    };
    const result = await this.execute(
      `INSERT INTO ${this.table('quant_signal_monitors')}
      SELECT {id:String}, {owner:String}, payload, {next:UInt64} FROM input('payload String')
      WHERE EXISTS (SELECT 1 FROM ${this.table('quant_signal_monitors')} FINAL WHERE id={id:String} AND revision={revision:UInt64}) FORMAT JSONEachRow`,
      {
        id,
        owner,
        next: String(row.revision),
        revision: String(revision),
      },
      JSON.stringify({ payload: JSON.stringify(row) }),
      'signal-monitor-config',
    );
    if (!result.writtenRows) throw new StrategyError('MONITOR_CONFLICT', 409);
    return this.view(deleted ? await this.finishDelete(row) : row);
  }
  async acquire(id: string, owner: string) {
    // Older databases also have an inline checkpoint column. Name the columns
    // so its implicit default is used without changing or dropping that data.
    const result = await this.execute(
      `INSERT INTO ${this.table('quant_signal_runtime')} (id, ownerId, expiresAt, status, message, version)
      SELECT {id:String}, {owner:String}, ${timeSql}+30, 'starting', '正在准备实时计算', ${versionSql}
      WHERE EXISTS (SELECT 1 FROM ${this.table('quant_signal_monitors')} FINAL WHERE id={id:String} AND NOT JSONExtractBool(payload,'deleted') AND JSONExtractBool(payload,'enabled'))
      AND NOT EXISTS (SELECT 1 FROM ${this.table('quant_signal_runtime')} FINAL WHERE id={id:String} AND expiresAt>${timeSql} AND ownerId!={owner:String})`,
      { id, owner },
      undefined,
      `signal-monitor:${id}`,
    );
    return result.writtenRows > 0;
  }
  async heartbeat(
    id: string,
    owner: string,
    status: SignalMonitor['status'],
    message: string,
    checkpoint?: string,
    release = false,
  ) {
    const fence = this.history.fence();
    if (checkpoint !== undefined) {
      const saved = await this.execute(
        `INSERT INTO ${this.table('quant_signal_checkpoints')}
         SELECT {id:String}, checkpoint, ${versionSql} FROM input('checkpoint String')
         WHERE ${fence} FORMAT JSONEachRow`,
        { id, owner, monitor: id, worker: owner },
        JSON.stringify({ checkpoint }),
        `signal-monitor:${id}`,
      );
      if (!saved.writtenRows) return false;
    }
    const result = await this.execute(
      `INSERT INTO ${this.table('quant_signal_runtime')} (id, ownerId, expiresAt, status, message, version)
       SELECT {id:String}, {owner:String}, ${release ? '0' : `${timeSql}+30`}, {status:String}, message, ${versionSql}
       FROM input('message String') WHERE ${fence} FORMAT JSONEachRow`,
      { id, owner, status, monitor: id, worker: owner },
      JSON.stringify({ message }),
      // Renewals must not queue behind multi-MiB checkpoint/history writes.
      // Acquisition still uses the writer lock; the owner/expiry fence keeps
      // late renewals from replacing a newer lease.
      `signal-heartbeat:${id}`,
    );
    return result.writtenRows > 0;
  }
  async signal(_owner: string, signal: StrategySignal, worker: string) {
    await this.history.save(signal.monitor_id, worker, {
      records: [
        { kind: 'signal', id: signal.id, time: signal.time, payload: signal },
      ],
    });
  }
  async overlay(id: string): Promise<SignalOverlay> {
    const [row] = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_signal_overlays')} FINAL WHERE id={id:String}`,
      { id },
    );
    return row ? JSON.parse(row.payload) : { updated_at: null, levels: [] };
  }
  async saveOverlay(id: string, owner: string, overlay: SignalOverlay) {
    const result = await this.execute(
      `INSERT INTO ${this.table('quant_signal_overlays')}
       SELECT {id:String}, payload, ${versionSql} FROM input('payload String')
       WHERE ${this.history.fence()} FORMAT JSONEachRow`,
      { id, owner, monitor: id, worker: owner },
      JSON.stringify({ payload: JSON.stringify(overlay) }),
      `signal-monitor:${id}`,
    );
    return result.writtenRows > 0;
  }
  async signals(owner: string, id: string): Promise<StrategySignal[]> {
    const row = await this.get(id, owner);
    if (row.deleted) throw new StrategyError('MONITOR_NOT_FOUND', 404);
    return this.history.signals(id);
  }
  private async finishDelete(row: StoredMonitor) {
    if (row.history_cleared) return row;
    await this.history.clear(row.id);
    const next = { ...row, history_cleared: true, revision: row.revision + 1 };
    await this.execute(
      `INSERT INTO ${this.table('quant_signal_monitors')}
      SELECT {id:String}, {owner:String}, payload, {revision:UInt64}+1 FROM input('payload String')
      WHERE EXISTS (SELECT 1 FROM ${this.table('quant_signal_monitors')} FINAL WHERE id={id:String}
        AND revision={revision:UInt64} AND JSONExtractBool(payload,'deleted')) FORMAT JSONEachRow`,
      { id: row.id, owner: row.user_id, revision: String(row.revision) },
      JSON.stringify({ payload: JSON.stringify(next) }),
      'signal-monitor-config',
    );
    return this.get(row.id, row.user_id);
  }
  async cleanupDeleted() {
    const rows = await this.rows<{
      payload: string;
    }>(`SELECT payload FROM ${this.table('quant_signal_monitors')} FINAL
      WHERE JSONExtractBool(payload,'deleted') AND NOT JSONExtractBool(payload,'history_cleared') LIMIT 20`);
    for (const row of rows) await this.finishDelete(JSON.parse(row.payload));
  }
}
