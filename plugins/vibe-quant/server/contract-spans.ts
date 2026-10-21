import type { ClickHouseClient } from './clickhouse-client.js';

export interface ContractSpan {
  underlying: string;
  from: number;
  to: number;
}

/** Observed historical runs, including both bounding quotes. Empty mappings and
 * every contract change break a run; matching names across a roll never merge.
 */
export function readContractSpans(
  client: ClickHouseClient,
  symbol: string,
  from: number,
  to: number,
): Promise<ContractSpan[]> {
  const scope = `FROM ${client.table('quotes')} FINAL
    WHERE engine = 'tqsdk' AND symbol = {symbol:String}`;
  const neighbor = (predicate: string, order: string) =>
    `SELECT time, underlying ${scope} AND time IN (
      SELECT time FROM ${client.table('quotes')}
      WHERE engine = 'tqsdk' AND symbol = {symbol:String} AND ${predicate}
      ORDER BY time ${order} LIMIT 1)`;
  return client.rows<ContractSpan>(
    `WITH source AS (
      SELECT time, underlying ${scope} AND time >= {from:Float64} AND time <= {to:Float64}
      UNION ALL ${neighbor('time < {from:Float64}', 'DESC')}
      UNION ALL ${neighbor('time > {to:Float64}', 'ASC')}
    ), changes AS (
      SELECT *, row_number() OVER w = 1 OR underlying != lagInFrame(underlying) OVER w AS changed
      FROM source WINDOW w AS (ORDER BY time ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ), runs AS (
      SELECT *, sum(changed) OVER (ORDER BY time) AS run FROM changes
    )
    SELECT underlying, min(time) AS from, max(time) AS to
    FROM runs GROUP BY run, underlying ORDER BY from
    SETTINGS max_execution_time = 8, max_rows_to_read = 10000000, read_overflow_mode = 'throw'`,
    { symbol, from: String(from), to: String(to) },
  );
}
