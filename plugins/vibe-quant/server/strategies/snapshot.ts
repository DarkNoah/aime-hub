import type { Bar, Engine, Instrument } from '../../shared.js';
import type { BacktestInput } from '../../strategy-types.js';
import type { MarketStore } from '../clickhouse.js';
import type { StateStore } from '../state-store.js';
import { ClickHouseError } from '../clickhouse-client.js';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_BACKTEST_BARS } from './limits.js';
import { completeFiveMinuteBars } from './signal-bars.js';

export interface RawSnapshot {
  engine: Engine;
  config: BacktestInput;
  instruments: Record<string, Instrument>;
  mappings: Record<string, { time: number; underlying: string }[]>;
  bars: Bar[];
  derived_bars?: {
    symbol: string;
    duration: number;
    source_duration: number;
    count: number;
    replaced: number;
  }[];
}
/** Read through the same market store as the chart, then freeze before user code executes. */
export async function collectSnapshot(
  store: MarketStore,
  state: StateStore,
  engine: Engine,
  config: BacktestInput,
  signal: AbortSignal,
): Promise<RawSnapshot> {
  const result: RawSnapshot = {
    engine,
    config,
    instruments: {},
    mappings: {},
    bars: [],
  };
  const requests = new Map<string, [string, number]>();
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        const transient =
          (error instanceof ClickHouseError && error.code === 241) ||
          (error instanceof Error && error.name === 'TimeoutError');
        if (!transient || attempt >= 3) throw error;
        // These calls only read a page/catalog entry, so retry cannot duplicate a write.
        await delay(500 * 2 ** attempt, undefined, { signal });
      }
    }
  };
  const instrument = async (symbol: string) => {
    signal.throwIfAborted();
    const item =
      result.instruments[symbol] ??
      (await read(() => state.instrument(engine, symbol)));
    if (
      !item ||
      item.kind === 'option' ||
      (item.kind === 'continuous' && !symbol.startsWith('KQ.m@'))
    )
      throw new Error(`不支持的回测标的：${symbol}`);
    result.instruments[symbol] = item;
    return item;
  };
  const request = (symbol: string, duration: number) =>
    requests.set(`${symbol}:${duration}`, [
      symbol,
      duration === 180 ? 60 : duration,
    ]);
  for (const symbol of new Set([
    config.symbol,
    ...(config.benchmark_symbol ? [config.benchmark_symbol] : []),
  ])) {
    const item = await instrument(symbol);
    request(symbol, config.duration);
    if (
      item.kind !== 'continuous' ||
      (config.execution_model === 'continuous_price' &&
        symbol === config.symbol)
    )
      request(symbol, 60);
    else {
      const initial = await store.rows<{ time: number; underlying: string }>(
        `SELECT time, underlying FROM ${store.table('quotes')} FINAL
        WHERE engine={engine:String} AND symbol={symbol:String} AND time <= {start:Float64} ORDER BY time DESC LIMIT 1`,
        { engine, symbol, start: String(config.start) },
      );
      if (!initial[0]?.underlying)
        throw new Error(
          `${symbol} 缺少起始时点的历史主力映射，请补齐数据或调整起始时间`,
        );
      const changes = await store.rows<{ time: number; underlying: string }>(
        `SELECT time, underlying FROM (
        SELECT time, underlying, lagInFrame(underlying, 1, '') OVER (ORDER BY time ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS previous
        FROM ${store.table('quotes')} FINAL WHERE engine={engine:String} AND symbol={symbol:String} AND time > {start:Float64} AND time < {end:Float64}
        ) WHERE underlying != previous ORDER BY time LIMIT 101`,
        {
          engine,
          symbol,
          start: String(config.start),
          end: String(config.end),
        },
      );
      if (changes.length > 100)
        throw new Error('主力切换次数超过单次回测限制，请缩短时间范围');
      result.mappings[symbol] = [...initial, ...changes];
      const contracts = new Set(
        result.mappings[symbol].map((row) => row.underlying),
      );
      if (contracts.size > 24)
        throw new Error('单次回测最多包含 24 个实际合约，请缩短时间范围');
      for (const contract of contracts) {
        if (
          !contract ||
          !contract.startsWith(symbol.slice(5)) ||
          !/^\d+$/.test(contract.slice(symbol.length - 5))
        )
          throw new Error('历史主力映射包含不匹配的实际合约');
        if ((await instrument(contract)).kind !== 'future')
          throw new Error('主连必须映射到期货合约');
        request(contract, 60);
      }
    }
  }
  const loaded = new Set<string>();
  for (const [symbol, duration] of requests.values()) {
    const key = `${symbol}:${duration}`;
    if (loaded.has(key)) continue;
    loaded.add(key);
    // Match the market table's Shanghai monthly partitions. A LIMIT alone
    // still merges every remaining FINAL partition on a multi-year request.
    let windowStart = config.start;
    while (windowStart < config.end) {
      const local = new Date((windowStart + 8 * 3600) * 1000);
      const before = Math.min(
        config.end,
        Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) / 1000 -
          8 * 3600,
      );
      let after = windowStart - 1;
      while (true) {
        signal.throwIfAborted();
        const rows = await read(() =>
          store.bars(engine, symbol, duration, {
            after,
            before,
            limit: 1000,
            singleThread: true,
            // Continuous-price research freezes the stored main bars and
            // deliberately has no dependency on actual-contract Tick history.
            rebuildTicks: !(
              config.execution_model === 'continuous_price' &&
              symbol === config.symbol
            ),
          }),
        );
        result.bars.push(...rows);
        if (result.bars.length > MAX_BACKTEST_BARS)
          throw new Error('单次回测最多 500,000 根数据 K 线，请缩短区间');
        if (rows.length < 1000) break;
        const next = rows.at(-1)!.time;
        if (next <= after) throw new Error('历史数据分页未前进');
        after = next;
      }
      windowStart = before;
    }
  }
  if (config.duration === 300) {
    for (const symbol of new Set([
      config.symbol,
      ...(config.benchmark_symbol ? [config.benchmark_symbol] : []),
    ])) {
      const derived = completeFiveMinuteBars(result.bars, symbol, config.end);
      if (!derived.length) continue;
      const times = new Set(derived.map((bar) => bar.time));
      const remaining = result.bars.filter(
        (bar) =>
          !(
            bar.symbol === symbol &&
            bar.duration === 300 &&
            times.has(bar.time)
          ),
      );
      const replaced = result.bars.length - remaining.length;
      if (remaining.length + derived.length > MAX_BACKTEST_BARS)
        throw new Error('单次回测最多 500,000 根数据 K 线，请缩短区间');
      result.bars = remaining.concat(derived);
      (result.derived_bars ??= []).push({
        symbol,
        duration: 300,
        source_duration: 60,
        count: derived.length,
        replaced,
      });
    }
  }
  return result;
}
