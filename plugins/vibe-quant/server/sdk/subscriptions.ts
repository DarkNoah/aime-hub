import type { QuantConfig } from '../config.js';
import { ClickHouseClient, timeSql, versionSql } from '../clickhouse-client.js';

/** Short-lived SDK sessions share subscriptions with the existing collector. */
export class StrategySubscriptions extends ClickHouseClient {
  constructor(config: QuantConfig) {
    super(config);
  }

  activeSql() {
    return `SELECT symbol FROM ${this.table('quant_strategy_subscriptions')} FINAL
      WHERE engine = {engine:String} AND expiresAt > ${timeSql}`;
  }

  async retain(
    userId: string,
    sessionId: string,
    symbols: string[],
  ): Promise<boolean> {
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
       )) <= {limit:UInt32}`,
      {
        userId,
        sessionId,
        engine: this.config.engine,
        symbols: JSON.stringify(symbols),
        limit: String(this.config.maxSubscriptions),
      },
      undefined,
      'watchlist',
    );
    return result.writtenRows === symbols.length;
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
