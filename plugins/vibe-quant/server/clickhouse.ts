import type { Bar, Engine, OrderBook, Quote, Tick } from '../shared.js';
import type { QuantConfig } from './config.js';
import { LiveMarket } from './live-market.js';
import { ClickHouseClient, timeSql } from './clickhouse-client.js';
import { tickColumns, validateTickVolumes } from './tick-validation.js';
import { aggregateBars, derivedPeriod, periodStart } from './bar-periods.js';

/** Only identifiers validated by parseConfig are interpolated; values use CH parameters. */
export class MarketStore extends ClickHouseClient {
  private readonly live = new LiveMarket();
  constructor(config: QuantConfig) {
    super(config);
  }
  async initialize() {
    if (this.config.clickhouseReadOnly) {
      // Market tables must have been provisioned by a writer. This switch
      // only suppresses market writes; StateStore still persists plugin state.
      for (const table of ['quotes', 'bars', 'order_books'])
        await this.request(`SELECT symbol FROM ${this.table(table)} LIMIT 0`);
      return;
    }
    // The database is provisioned by the operator. Do not require cluster-level CREATE DATABASE.
    await this.request(`CREATE TABLE IF NOT EXISTS ${this.table('quotes')} (
      engine LowCardinality(String), symbol LowCardinality(String), time Float64,
      last Nullable(Float64), preClose Nullable(Float64), open Nullable(Float64), high Nullable(Float64), low Nullable(Float64),
      volume Nullable(Float64), amount Nullable(Float64), openInterest Nullable(Float64), bid Nullable(Float64), ask Nullable(Float64),
      underlying String, version UInt64
    ) ENGINE = ReplacingMergeTree(version) PARTITION BY toYYYYMM(toDateTime(time, 'Asia/Shanghai')) ORDER BY (engine, symbol, time)`);
    await this.request(`CREATE TABLE IF NOT EXISTS ${this.table('bars')} (
      engine LowCardinality(String), symbol LowCardinality(String), duration UInt32, time UInt64,
      open Float64, high Float64, low Float64, close Float64, volume Float64, version UInt64
    ) ENGINE = ReplacingMergeTree(version) PARTITION BY toYYYYMM(toDateTime(time, 'Asia/Shanghai')) ORDER BY (engine, symbol, duration, time)`);
    // Separate receipt identity preserves depth-only changes even when source time
    // repeats or is unavailable. Retrying a batch keeps the same snapshot IDs.
    await this
      .request(`CREATE TABLE IF NOT EXISTS ${this.table('order_books')} (
      engine LowCardinality(String), symbol LowCardinality(String), snapshotId UUID,
      sourceTime Nullable(Float64), receivedAt Float64, timePrecision LowCardinality(String),
      bidPrices Array(Nullable(Float64)), bidVolumes Array(Nullable(Float64)),
      askPrices Array(Nullable(Float64)), askVolumes Array(Nullable(Float64)),
      volumeUnit LowCardinality(String), underlying String, version UInt64
    ) ENGINE = ReplacingMergeTree(version) PARTITION BY toYYYYMM(toDateTime(receivedAt, 'Asia/Shanghai'))
      ORDER BY (engine, symbol, receivedAt, snapshotId)`);
    await this.request(`CREATE TABLE IF NOT EXISTS ${this.table('ticks')} (
      engine LowCardinality(String), symbol LowCardinality(String), ${tickColumns}, version UInt64
    ) ENGINE = ReplacingMergeTree(version) PARTITION BY toYYYYMM(tradingDay)
      ORDER BY (engine, symbol, tradingDay, timeNs, tickId)`);
  }
  async write(
    engine: Engine,
    quotes: Quote[],
    bars: Bar[],
    orderBooks: OrderBook[] = [],
    ownerId?: string,
    ticks: Tick[] = [],
  ) {
    if (this.config.clickhouseReadOnly) {
      this.live.update(engine, quotes, bars, orderBooks);
      return;
    }
    const version = Date.now();
    // A retry is safe: replacement keys identify a source quote or bar, not the ingestion time.
    for (const [table, rows] of [
      ['quotes', quotes],
      ['bars', bars],
      ['order_books', orderBooks],
      ['ticks', ticks],
    ] as const) {
      if (!rows.length) continue;
      const body = rows
        .map((row) => JSON.stringify({ ...row, engine, version }))
        .join('\n');
      if (ownerId) {
        // Fencing is checked inside the insert, serialized with lease changes.
        // A producer whose lease expired cannot write after another takes over.
        const result = await this.execute(
          `INSERT INTO ${this.table(table)} SELECT * FROM input(${this.inputSchema(table)})
           WHERE EXISTS (SELECT 1 FROM ${this.table('quant_leases')} FINAL
             WHERE engine = {engine:String} AND ownerId = {ownerId:String} AND expiresAt > ${timeSql})
           FORMAT JSONEachRow`,
          { engine, ownerId },
          body,
          `collector:${engine}`,
        );
        if (!result.writtenRows) throw new Error('WRITER_LEASE_LOST');
      } else {
        await this.request(
          `INSERT INTO ${this.table(table)} FORMAT JSONEachRow`,
          {},
          body,
        );
      }
    }
  }
  private inputSchema(table: 'quotes' | 'bars' | 'order_books' | 'ticks') {
    const prefix = 'engine String, symbol String';
    const columns = {
      quotes:
        'time Float64, last Nullable(Float64), preClose Nullable(Float64), open Nullable(Float64), high Nullable(Float64), low Nullable(Float64), volume Nullable(Float64), amount Nullable(Float64), openInterest Nullable(Float64), bid Nullable(Float64), ask Nullable(Float64), underlying String',
      bars: 'duration UInt32, time UInt64, open Float64, high Float64, low Float64, close Float64, volume Float64',
      order_books:
        'snapshotId UUID, sourceTime Nullable(Float64), receivedAt Float64, timePrecision String, bidPrices Array(Nullable(Float64)), bidVolumes Array(Nullable(Float64)), askPrices Array(Nullable(Float64)), askVolumes Array(Nullable(Float64)), volumeUnit String, underlying String',
      ticks: tickColumns,
    };
    return `'${prefix}, ${columns[table]}, version UInt64'`;
  }
  retainSymbols(engine: Engine, symbols: string[]) {
    this.live.retainSymbols(engine, symbols);
  }
  validateTickVolumes(engine: Engine, symbol: string, tradingDay: string) {
    return validateTickVolumes(this, engine, symbol, tradingDay);
  }
  async quotes(engine: Engine, symbols: string[]): Promise<Quote[]> {
    if (!symbols.length) return [];
    const text = await this.request(
      `SELECT symbol, time, last, preClose, open, high, low, volume, amount, openInterest, bid, ask, underlying
      FROM ${this.table('quotes')} FINAL WHERE engine = {engine:String} AND symbol IN (SELECT arrayJoin(JSONExtract({symbols:String}, 'Array(String)')))
      ORDER BY time DESC LIMIT 1 BY symbol FORMAT JSON`,
      { engine, symbols: JSON.stringify(symbols) },
    );
    const saved: Quote[] = JSON.parse(text).data;
    return this.config.clickhouseReadOnly
      ? this.live.quotes(engine, symbols, saved)
      : saved;
  }
  async orderBooks(engine: Engine, symbols: string[]): Promise<OrderBook[]> {
    if (!symbols.length) return [];
    const text = await this.request(
      `SELECT symbol, snapshotId, sourceTime, receivedAt, timePrecision,
        bidPrices, bidVolumes, askPrices, askVolumes, volumeUnit, underlying
       FROM ${this.table('order_books')} FINAL
       WHERE engine = {engine:String} AND symbol IN (SELECT arrayJoin(JSONExtract({symbols:String}, 'Array(String)')))
       ORDER BY receivedAt DESC, snapshotId DESC LIMIT 1 BY symbol FORMAT JSON`,
      { engine, symbols: JSON.stringify(symbols) },
    );
    const saved: OrderBook[] = JSON.parse(text).data;
    return this.config.clickhouseReadOnly
      ? this.live.orderBooks(engine, symbols, saved)
      : saved;
  }
  async bars(
    engine: Engine,
    symbol: string,
    duration: number,
    before?: number,
  ): Promise<Bar[]> {
    const period = derivedPeriod(duration);
    const sourceDuration = period?.source ?? duration;
    const limit = period?.limit ?? 1000;
    const boundary =
      before === undefined
        ? Math.floor(Date.now() / 1000) + 86400
        : period
          ? Math.max(0, periodStart(before, duration))
          : before;
    const text = await this.request(
      `SELECT symbol, duration, toFloat64(time) AS time, open, high, low, close, volume
      FROM ${this.table('bars')} FINAL WHERE engine = {engine:String} AND symbol = {symbol:String} AND duration = {duration:UInt32}
      AND time < {before:UInt64} ORDER BY time DESC LIMIT {limit:UInt32} FORMAT JSON`,
      {
        engine,
        symbol,
        duration: String(sourceDuration),
        before: String(boundary),
        limit: String(limit),
      },
    );
    const saved: Bar[] = JSON.parse(text).data.reverse();
    const bars = this.config.clickhouseReadOnly
      ? this.live.bars(engine, symbol, sourceDuration, boundary, saved, limit)
      : saved;
    return period ? aggregateBars(bars, duration) : bars;
  }
}
