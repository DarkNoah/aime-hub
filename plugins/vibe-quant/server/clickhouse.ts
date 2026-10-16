import type { Bar, Engine, OrderBook, Quote } from '../shared.js';
import type { QuantConfig } from './config.js';

/** Only identifiers validated by parseConfig are interpolated; values use CH parameters. */
export class MarketStore {
  constructor(private readonly config: QuantConfig) {}
  private async request(
    query: string,
    params: Record<string, string> = {},
    body?: string,
  ) {
    const url = new URL(this.config.clickhouseUrl);
    url.searchParams.set('query', query);
    url.searchParams.set('wait_end_of_query', '1');
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(`param_${key}`, value);
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'X-ClickHouse-User': this.config.clickhouseUser,
        'X-ClickHouse-Key': this.config.clickhousePassword,
      },
      body,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`CLICKHOUSE_HTTP_${response.status}`);
    }
    return response.text();
  }
  private table(name: string) {
    return `\`${this.config.clickhouseDatabase}\`.${name}`;
  }
  async initialize() {
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
  }
  async write(
    engine: Engine,
    quotes: Quote[],
    bars: Bar[],
    orderBooks: OrderBook[] = [],
  ) {
    const version = Date.now();
    // A retry is safe: replacement keys identify a source quote or bar, not the ingestion time.
    for (const [table, rows] of [
      ['quotes', quotes],
      ['bars', bars],
      ['order_books', orderBooks],
    ] as const) {
      if (rows.length)
        await this.request(
          `INSERT INTO ${this.table(table)} FORMAT JSONEachRow`,
          {},
          rows
            .map((row) => JSON.stringify({ ...row, engine, version }))
            .join('\n'),
        );
    }
  }
  async quotes(engine: Engine, symbols: string[]): Promise<Quote[]> {
    if (!symbols.length) return [];
    const text = await this.request(
      `SELECT symbol, time, last, preClose, open, high, low, volume, amount, openInterest, bid, ask, underlying
      FROM ${this.table('quotes')} FINAL WHERE engine = {engine:String} AND symbol IN (SELECT arrayJoin(JSONExtract({symbols:String}, 'Array(String)')))
      ORDER BY time DESC LIMIT 1 BY symbol FORMAT JSON`,
      { engine, symbols: JSON.stringify(symbols) },
    );
    return JSON.parse(text).data;
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
    return JSON.parse(text).data;
  }
  async bars(
    engine: Engine,
    symbol: string,
    duration: number,
    before?: number,
  ): Promise<Bar[]> {
    const text = await this.request(
      `SELECT symbol, duration, toFloat64(time) AS time, open, high, low, close, volume
      FROM ${this.table('bars')} FINAL WHERE engine = {engine:String} AND symbol = {symbol:String} AND duration = {duration:UInt32}
      AND time < {before:UInt64} ORDER BY time DESC LIMIT 1000 FORMAT JSON`,
      {
        engine,
        symbol,
        duration: String(duration),
        before: String(before ?? Math.floor(Date.now() / 1000) + 86400),
      },
    );
    return JSON.parse(text).data.reverse();
  }
}
