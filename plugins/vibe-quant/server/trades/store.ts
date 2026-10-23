import { ClickHouseClient } from '../clickhouse-client.js';
import { dateAt, type TradeDay, type TradePrint } from './types.js';

type PrintTuple = [
  number,
  number,
  number,
  TradePrint['side'],
  TradePrint['precision'],
  number,
  number | null,
  number | null,
  string,
];
type StoredDay = Omit<TradeDay, 'trades' | 'isFinal'> & {
  isFinal: number;
  prints: PrintTuple[];
};

/** One atomic day snapshot mirrors stock-rl's transactional replace-day storage.
 * Array positions retain identical prints without inventing exchange trade IDs.
 * ReplacingMergeTree compacts old snapshots, including abandoned/shorter refreshes.
 * This table is independent of ticks, bars, quotes and order_books.
 */
export class TradeStore extends ClickHouseClient {
  async initialize() {
    if (this.config.clickhouseReadOnly) return;
    await this
      .request(`CREATE TABLE IF NOT EXISTS ${this.table('tdx_trade_days')} (
      symbol LowCardinality(String), date Date, source LowCardinality(String), sourceSymbol String,
      market UInt16, fetchedAt Float64, isFinal UInt8,
      prints Array(Tuple(Float64, Float64, Float64, String, String, Int32, Nullable(Float64), Nullable(Int32), String)),
      version UInt64
    ) ENGINE = ReplacingMergeTree(version) PARTITION BY toYYYYMM(date) ORDER BY (symbol, date)`);
  }
  async readDay(symbol: string, date: string): Promise<TradeDay | undefined> {
    const [row] = await this.rows<StoredDay>(
      `SELECT symbol, date, source, sourceSymbol,
      market, fetchedAt, isFinal, prints FROM ${this.table('tdx_trade_days')} FINAL
      WHERE symbol = {symbol:String} AND date = {date:Date} LIMIT 1
      SETTINGS max_execution_time = 8`,
      { symbol, date },
    );
    if (!row) return;
    const { prints, isFinal, ...metadata } = row;
    return {
      ...metadata,
      isFinal: !!isFinal,
      trades: prints.map((p) => ({
        time: p[0],
        price: p[1],
        size: p[2],
        side: p[3],
        precision: p[4],
        direction: p[5],
        openInterestChange: p[6],
        nature: p[7],
        natureName: p[8],
      })),
    };
  }
  async saveDay(day: TradeDay) {
    if (this.config.clickhouseReadOnly)
      throw new Error('TRADE_STORE_READ_ONLY');
    if (
      day.trades.some(
        (row) => dateAt(row.time) !== day.date || row.time > day.fetchedAt,
      )
    )
      throw new Error('TRADE_DAY_MISMATCH');
    const { trades, ...metadata } = day;
    const prints: PrintTuple[] = trades.map((row) => [
      row.time,
      row.price,
      row.size,
      row.side,
      row.precision,
      row.direction,
      row.openInterestChange,
      row.nature,
      row.natureName,
    ]);
    // Version is captured BEFORE fetching. A slower, older refresh cannot replace a newer one.
    await this.request(
      `INSERT INTO ${this.table('tdx_trade_days')} FORMAT JSONEachRow`,
      {},
      JSON.stringify({
        ...metadata,
        isFinal: Number(day.isFinal),
        prints,
        version: Math.round(day.fetchedAt * 1_000_000),
      }),
    );
  }
}
