import {
  ClickHouseClient,
  ClickHouseError,
  timeSql,
  versionSql,
} from '../clickhouse-client.js';
import type {
  SignalHistoryBatch,
  SignalHistorySummary,
} from '../../signal-history.js';
import type { StrategySignal } from '../../signal-types.js';
import type { OpenTrade, Trade, TradeRecord } from '../../strategy-types.js';
import { StrategyError } from '../strategies/schema.js';

/** A monitor owns a fresh history, independently of strategy backtest runs. */
export class SignalHistoryStore extends ClickHouseClient {
  async initialize() {
    try {
      await this.request(
        `SELECT 1 FROM ${this.table('quant_signal_history')} LIMIT 0`,
      );
    } catch (error) {
      if (!(error instanceof ClickHouseError) || error.code !== 60) throw error;
      await this
        .request(`CREATE TABLE IF NOT EXISTS ${this.table('quant_signal_history')} (
        monitorId String, kind String, id String, time Float64,
        payload String CODEC(ZSTD(3)), version UInt64
      ) ENGINE = ReplacingMergeTree(version) ORDER BY (monitorId, kind, id)`);
    }
  }
  fence() {
    return `EXISTS (SELECT 1 FROM ${this.table('quant_signal_monitors')} FINAL
      WHERE id={monitor:String} AND NOT JSONExtractBool(payload,'deleted') AND JSONExtractBool(payload,'enabled'))
      AND EXISTS (SELECT 1 FROM ${this.table('quant_signal_runtime')} FINAL
      WHERE id={monitor:String} AND ownerId={worker:String} AND expiresAt>${timeSql})`;
  }
  async save(monitor: string, worker: string, batch: SignalHistoryBatch) {
    const rows = [...batch.records];
    if (batch.summary)
      rows.push({
        kind: 'summary',
        id: 'summary',
        time: batch.summary.through,
        payload: batch.summary,
      });
    if (!rows.length) return;
    const result = await this.execute(
      `INSERT INTO ${this.table('quant_signal_history')}
      SELECT {monitor:String}, kind, id, time, payload, ${versionSql}
      FROM input('kind String, id String, time Float64, payload String')
      WHERE ${this.fence()} FORMAT JSONEachRow`,
      { monitor, worker },
      rows
        .map((row) =>
          JSON.stringify({ ...row, payload: JSON.stringify(row.payload) }),
        )
        .join('\n'),
      `signal-monitor:${monitor}`,
    );
    if (result.writtenRows !== rows.length)
      throw new Error('实时计算租约已失效');
  }
  async signals(monitor: string): Promise<StrategySignal[]> {
    return (await this.page<StrategySignal>(monitor, 'signal')).rows;
  }
  async chart(monitor: string, range?: { from: number; to: number }) {
    const limit = range ? 2000 : 50;
    const [closed, summary] = await Promise.all([
      this.rows<{ payload: string }>(
        `SELECT payload FROM ${this.table('quant_signal_history')} FINAL
         WHERE monitorId={monitor:String} AND kind='trade'
         ${range ? "AND time >= {from:Float64} AND JSONExtractFloat(payload,'entry_time') < {to:Float64}" : ''}
         ORDER BY time DESC,id DESC LIMIT {limit:UInt32}`,
        {
          monitor,
          from: String(range?.from ?? 0),
          to: String(range?.to ?? 0),
          limit: String(limit + 1),
        },
      ),
      this.rows<{ opened: string }>(
        `SELECT JSONExtractRaw(payload,'open_trades') AS opened
         FROM ${this.table('quant_signal_history')} FINAL
         WHERE monitorId={monitor:String} AND kind='summary' AND id='summary'`,
        { monitor },
      ),
    ]);
    const opened = JSON.parse(summary[0]?.opened || '[]') as OpenTrade[];
    return {
      trades: [
        ...closed
          .slice(0, limit)
          .map((row) => JSON.parse(row.payload) as Trade),
        ...opened.filter(
          (row) =>
            !range ||
            (row.entry_time < range.to && row.observed_until >= range.from),
        ),
      ] as TradeRecord[],
      trades_truncated: closed.length > limit,
    };
  }
  private async page<T>(
    monitor: string,
    kind: 'trade' | 'signal',
    before?: string,
  ) {
    let cursor: { time: number; id: string } | undefined;
    if (before) {
      try {
        cursor = JSON.parse(Buffer.from(before, 'base64url').toString());
        if (
          !cursor ||
          !Number.isFinite(cursor.time) ||
          typeof cursor.id !== 'string'
        )
          throw new Error();
      } catch {
        throw new StrategyError('INVALID_MONITOR_CONFIG');
      }
    }
    const rows = await this.rows<{ id: string; time: number; payload: string }>(
      `SELECT id,time,payload FROM ${this.table('quant_signal_history')} FINAL
        WHERE monitorId={monitor:String} AND kind={kind:String}
        ${cursor ? 'AND (time,id)<({time:Float64},{id:String})' : ''}
        ORDER BY time DESC,id DESC LIMIT 51`,
      { monitor, kind, time: String(cursor?.time ?? 0), id: cursor?.id ?? '' },
    );
    const page = rows.slice(0, 50),
      last = page.at(-1);
    return {
      rows: page.map((row) => JSON.parse(row.payload) as T),
      next:
        rows.length > 50 && last
          ? Buffer.from(
              JSON.stringify({ time: last.time, id: last.id }),
            ).toString('base64url')
          : null,
    };
  }
  async read(monitor: string, before?: string, signalsBefore?: string) {
    const [summary, trades, signals] = await Promise.all([
      this.rows<{ payload: string }>(
        `SELECT payload FROM ${this.table('quant_signal_history')} FINAL
        WHERE monitorId={monitor:String} AND kind='summary' AND id='summary'`,
        { monitor },
      ),
      this.page<Trade>(monitor, 'trade', before),
      this.page<StrategySignal>(monitor, 'signal', signalsBefore),
    ]);
    return {
      summary: summary[0]
        ? (JSON.parse(summary[0].payload) as SignalHistorySummary)
        : null,
      trades: trades.rows,
      signals: signals.rows,
      next: trades.next,
      signals_next: signals.next,
    };
  }
  /** Config is tombstoned first. The shared query lock drains any in-flight writer. */
  async clear(monitor: string) {
    for (const [table, key] of [
      ['quant_signal_history', 'monitorId'],
      ['quant_signal_events', 'monitorId'],
      ['quant_signal_checkpoints', 'id'],
      ['quant_signal_overlays', 'id'],
      ['quant_signal_runtime', 'id'],
    ])
      await this.execute(
        `ALTER TABLE ${this.table(table)} DELETE WHERE ${key}={monitor:String} SETTINGS mutations_sync=1`,
        { monitor },
        undefined,
        table === 'quant_signal_runtime'
          ? `signal-heartbeat:${monitor}`
          : `signal-monitor:${monitor}`,
      );
  }
}
