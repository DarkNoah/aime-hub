import type { QuantConfig } from '../config.js';
import { ClickHouseClient, timeSql, versionSql } from '../clickhouse-client.js';

/** SDK and chart sessions share the collector's bounded, expiring subscriptions. */
export class StrategySubscriptions extends ClickHouseClient {
  constructor(config: QuantConfig) {
    super(config);
  }

  activeSql() {
    return `SELECT symbol FROM ${this.table('quant_strategy_subscriptions')} FINAL
      WHERE engine = {engine:String} AND expiresAt > ${timeSql}`;
  }

  retain(
    userId: string,
    sessionId: string,
    symbols: string[],
  ): Promise<boolean> {
    return this.retainSymbols(userId, sessionId, symbols);
  }

  retainView(userId: string, id: string, symbol: string) {
    return this.retainSymbols(userId, `view:${id}`, [symbol], symbol);
  }

  private async retainSymbols(
    userId: string,
    sessionId: string,
    symbols: string[],
    viewSymbol?: string,
  ) {
    if (!symbols.length) return false;
    const result = await this.execute(
      `INSERT INTO ${this.table('quant_strategy_subscriptions')}
       SELECT {userId:String}, {sessionId:String}, {engine:String}, symbol,
         ${timeSql} + 120, ${versionSql}
       FROM (SELECT arrayJoin(JSONExtract({symbols:String}, 'Array(String)')) AS symbol)
       WHERE (SELECT count(DISTINCT symbol) FROM (
         SELECT symbol FROM ${this.table('quant_watchlist')} FINAL
           WHERE enabled AND NOT deleted AND symbol IN (
             SELECT symbol FROM ${this.table('quant_instruments')} FINAL
             WHERE engine = {engine:String} AND NOT JSONExtractBool(metadata, 'expired'))
         UNION ALL ${this.activeSql()}
         UNION ALL SELECT arrayJoin(JSONExtract({symbols:String}, 'Array(String)')) AS symbol
       )) <= {limit:UInt32}
       ${
         viewSymbol
           ? `AND NOT EXISTS (SELECT 1 FROM ${this.table('quant_strategy_subscriptions')} FINAL
         WHERE engine = {engine:String} AND userId = {userId:String} AND sessionId = {sessionId:String}
           AND (expiresAt = 0 OR symbol != {viewSymbol:String}))`
           : ''
       }`,
      {
        userId,
        sessionId,
        engine: this.config.engine,
        symbols: JSON.stringify(symbols),
        ...(viewSymbol ? { viewSymbol } : {}),
        limit: String(this.config.maxSubscriptions),
      },
      undefined,
      'watchlist',
    );
    return result.writtenRows === symbols.length;
  }

  async releaseView(userId: string, id: string, symbol: string) {
    // Closing can reach the database ahead of a pending open or heartbeat.
    // A closed view ID is never reused. The tombstone also fences late retains.
    await this.execute(
      `INSERT INTO ${this.table('quant_strategy_subscriptions')}
       SELECT {userId:String}, {sessionId:String}, {engine:String}, {symbol:String}, 0, ${versionSql}`,
      { userId, sessionId: `view:${id}`, engine: this.config.engine, symbol },
      undefined,
      'watchlist',
    );
  }

  async release(userId: string, sessionId: string) {
    await this.execute(
      `INSERT INTO ${this.table('quant_strategy_subscriptions')}
      SELECT userId, sessionId, engine, symbol, 0, ${versionSql}
      FROM ${this.table('quant_strategy_subscriptions')} FINAL
      WHERE userId = {userId:String} AND sessionId = {sessionId:String} AND engine = {engine:String}`,
      { userId, sessionId, engine: this.config.engine },
    );
  }
}
