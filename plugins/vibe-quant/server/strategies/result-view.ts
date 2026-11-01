import type {
  BacktestResult,
  BacktestRun,
  TradeRecord,
} from '../../strategy-types.js';
import { tradeHoldingEnd } from '../../strategy-types.js';
import type {
  BacktestLogs,
  BacktestTradePage,
  BacktestView,
} from '../../backtest-view-types.js';
import {
  closedTradeWinRate,
  resultTradeRecords,
} from '../../strategy-trades.js';
import type { StrategyStore } from './store.js';

export const TRADE_PAGE_SIZE = 20;
export const MAX_CURVE_POINTS = 2400;

/** Keep both series' extrema in each bucket. Metrics always use the full result. */
export function overviewCurve(points: BacktestResult['equity_curve']) {
  const ordered = [
    ...new Map(points.map((point) => [point.time, point])).values(),
  ].sort((a, b) => a.time - b.time);
  let selected = ordered;
  if (ordered.length > MAX_CURVE_POINTS) {
    const indices = new Set([0, ordered.length - 1]);
    const buckets = Math.floor((MAX_CURVE_POINTS - 2) / 6);
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = 1 + Math.floor((bucket * (ordered.length - 2)) / buckets);
      const end =
        1 + Math.floor(((bucket + 1) * (ordered.length - 2)) / buckets);
      indices.add(start);
      indices.add(end - 1);
      for (const field of ['equity', 'benchmark_equity'] as const) {
        let min = -1,
          max = -1;
        for (let i = start; i < end; i++) {
          const value = ordered[i][field];
          if (value == null || !Number.isFinite(value)) continue;
          if (min < 0 || value < ordered[min][field]!) min = i;
          if (max < 0 || value > ordered[max][field]!) max = i;
        }
        if (min >= 0) indices.add(min);
        if (max >= 0) indices.add(max);
      }
    }
    selected = [...indices]
      .sort((a, b) => a - b)
      .map((index) => ordered[index]);
  }
  // Native reports may also contain cash, margin, positions, etc. per minute.
  return selected.map(({ time, trading_day, equity, benchmark_equity }) => ({
    time,
    trading_day,
    equity,
    benchmark_equity,
  }));
}

export function tradePage(
  trades: TradeRecord[],
  page: number,
): BacktestTradePage {
  return {
    items: trades.slice(page * TRADE_PAGE_SIZE, (page + 1) * TRADE_PAGE_SIZE),
    total: trades.length,
    page_size: TRADE_PAGE_SIZE,
  };
}

export function prepareResultView(
  result: BacktestResult,
  manifest: Record<string, unknown> | null,
) {
  const trades = resultTradeRecords(result).sort(
    (a, b) =>
      Number(b.status === 'open') - Number(a.status === 'open') ||
      (b.exit_time ?? b.entry_time) - (a.exit_time ?? a.entry_time) ||
      b.entry_time - a.entry_time,
  );
  const riskLevels = result.risk_levels ?? [];
  const view: BacktestView = {
    result: {
      metrics: result.metrics,
      equity_curve: overviewCurve(result.equity_curve ?? []),
      curve_points: result.equity_curve?.length ?? 0,
      monthly_returns: result.monthly_returns,
      yearly_returns: result.yearly_returns,
      closed_win_rate: closedTradeWinRate(result),
      trades: tradePage(trades, 0),
    },
    manifest,
  };
  const logs: BacktestLogs = {
    counts: {
      orders: result.orders?.length ?? 0,
      fills: result.fills?.length ?? 0,
      signals: result.signals?.length ?? 0,
      logs: result.logs?.length ?? 0,
      risk_levels: riskLevels.length,
    },
    orders: result.orders?.slice(-100) ?? [],
    logs: result.logs?.slice(-100) ?? [],
    risk_levels: riskLevels.slice(-100),
    account: result.account,
  };
  return { view, trades, riskLevels, logs };
}

export function selectedTradeRisk(
  model: ReturnType<typeof prepareResultView>,
  trade: TradeRecord,
) {
  return model.riskLevels.filter(
    (record) =>
      record.symbol === trade.symbol &&
      record.entry_signal_id === trade.entry_signal_id &&
      record.time <= tradeHoldingEnd(trade),
  );
}

type Model = ReturnType<typeof prepareResultView>;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_TTL = 60_000;

/** Cache only the compact read model, never the full minute curve or dataset. */
export class BacktestViewReader {
  private cache = new Map<
    string,
    { model: Model; bytes: number; expires: number }
  >();
  private pending = new Map<string, Promise<Model | null>>();
  private bytes = 0;

  async read(records: StrategyStore, run: BacktestRun): Promise<Model | null> {
    const key = `${run.id}:${run.status}:${run.finished_at}`;
    for (const [id, entry] of this.cache) {
      if (entry.expires <= Date.now()) {
        this.bytes -= entry.bytes;
        this.cache.delete(id);
      }
    }
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.model;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const load = async () => {
      const artifact = await records.artifact(run.id, 'result');
      if (!artifact) return null;
      const manifest = await records.artifact(run.id, 'manifest');
      const metadata = manifest ? JSON.parse(manifest.text) : null;
      const publicManifest = metadata
        ? Object.fromEntries(
            [
              'sdk_version',
              'tqsdk_version',
              'tq_rules',
              'data_snapshot_hash',
              'risk_model',
            ]
              .filter((key) => metadata[key] !== undefined)
              .map((key) => [key, metadata[key]]),
          )
        : null;
      const model = prepareResultView(
        JSON.parse(artifact.text),
        publicManifest,
      );
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        const bytes = Buffer.byteLength(JSON.stringify(model));
        if (bytes <= MAX_CACHE_BYTES) {
          while (this.bytes + bytes > MAX_CACHE_BYTES || this.cache.size >= 4) {
            const oldest = this.cache.entries().next().value;
            if (!oldest) break;
            this.bytes -= oldest[1].bytes;
            this.cache.delete(oldest[0]);
          }
          this.cache.set(key, {
            model,
            bytes,
            expires: Date.now() + CACHE_TTL,
          });
          this.bytes += bytes;
        }
      }
      return model;
    };
    const promise = load();
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }
}
