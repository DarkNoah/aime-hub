import type { Engine, TickVolumeValidation } from '../shared.js';
import type { ClickHouseClient } from './clickhouse-client.js';

export const tickColumns =
  'tickId UInt64, timeNs UInt64, tradingDay Date, receivedAt Float64, last Nullable(Float64), volume Nullable(Float64), amount Nullable(Float64), openInterest Nullable(Float64), bid Nullable(Float64), bidVolume Nullable(Float64), ask Nullable(Float64), askVolume Nullable(Float64), priceTick Nullable(Float64), volumeMultiple Nullable(Float64), volumeUnit String';

/** Recompute over FINAL so retries, restarts and later backfills cannot double-count.
 * Validation never assigns a snapshot's volume delta to its last price.
 */
export async function validateTickVolumes(
  client: ClickHouseClient,
  engine: Engine,
  symbol: string,
  tradingDay: string,
): Promise<TickVolumeValidation> {
  const [raw] = await client.rows<
    Omit<
      TickVolumeValidation,
      'state' | 'message' | 'checkedAt' | 'symbol' | 'tradingDay'
    >
  >(
    `WITH source AS (
      SELECT tickId, timeNs, last, volume, amount FROM ${client.table('ticks')} FINAL
      WHERE engine = {engine:String} AND symbol = {symbol:String} AND tradingDay = {day:Date}
    ), ordered AS (
      SELECT *, row_number() OVER w AS rn,
        lagInFrame(tickId) OVER w AS previousId,
        lagInFrame(volume) OVER w AS previousVolume,
        lagInFrame(amount) OVER w AS previousAmount
      FROM source WINDOW w AS (ORDER BY timeNs, tickId ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ), steps AS (
      SELECT *,
        rn > 1 AND tickId != previousId + 1 AS gap,
        isNull(volume) OR ifNull(volume < 0, false)
          OR (ifNull(volume > 0, false) AND (isNull(last) OR ifNull(last <= 0, false))) AS invalid,
        rn > 1 AND ifNull(volume < previousVolume, false) AS regression,
        rn > 1 AND ifNull(amount < previousAmount, false) AS amountRegression,
        volume - previousVolume AS delta,
        rn > 1 AND NOT gap AND NOT invalid
          AND ifNull(previousVolume >= 0 AND delta >= 0, false) AS usable,
        intDiv(timeNs, 60000000000) * 60 AS minute
      FROM ordered
    ), minutes AS (
      SELECT minute, sumIf(ifNull(delta, 0), usable) AS tickVolume,
        countIf(NOT usable) = 0
          AND minute + 60 <= (SELECT intDiv(max(timeNs), 1000000000) FROM source) AS covered
      FROM steps GROUP BY minute
    ), reference AS (
      SELECT time, volume AS barVolume, 1 AS present FROM ${client.table('bars')} FINAL
      WHERE engine = {engine:String} AND symbol = {symbol:String} AND duration = 60
        AND time IN (SELECT minute FROM minutes)
    ), reconciliation AS (
      SELECT countIf(covered AND present = 1) AS checkedMinutes,
        countIf(covered AND present = 1 AND abs(tickVolume - barVolume) > 0.000001) AS mismatchedMinutes,
        countIf(NOT covered OR present = 0) AS uncheckedMinutes
      FROM minutes LEFT JOIN reference ON minute = time
    )
    SELECT count() AS rows,
      if(count() = 0, NULL, toString(min(timeNs))) AS firstTimeNs,
      if(count() = 0, NULL, toString(max(timeNs))) AS lastTimeNs,
      argMin(tuple(volume), tuple(timeNs, tickId)).1 AS baselineVolume,
      argMax(tuple(volume), tuple(timeNs, tickId)).1 AS lastVolume,
      sumIf(ifNull(delta, 0), usable) AS observedVolume,
      sumIf(ifNull(delta, 0), gap AND ifNull(delta >= 0, false)) AS gapVolume,
      countIf(gap) AS sequenceGaps, countIf(regression) AS volumeRegressions,
      countIf(amountRegression) AS amountRegressions, countIf(invalid) AS invalidRows,
      (SELECT checkedMinutes FROM reconciliation) AS checkedMinutes,
      (SELECT mismatchedMinutes FROM reconciliation) AS mismatchedMinutes,
      (SELECT uncheckedMinutes FROM reconciliation) AS uncheckedMinutes
    FROM steps`,
    { engine, symbol, day: tradingDay },
  );
  // ClickHouse renders UInt64 aggregates as decimal strings in FORMAT JSON.
  const result = { ...raw };
  for (const key of [
    'rows',
    'observedVolume',
    'gapVolume',
    'sequenceGaps',
    'volumeRegressions',
    'amountRegressions',
    'invalidRows',
    'checkedMinutes',
    'mismatchedMinutes',
    'uncheckedMinutes',
  ] as const)
    result[key] = Number(result[key]);
  const warning =
    result.sequenceGaps ||
    result.volumeRegressions ||
    result.amountRegressions ||
    result.invalidRows ||
    result.mismatchedMinutes;
  const state = !result.rows
    ? 'empty'
    : warning
      ? 'warning'
      : result.baselineVolume !== 0 || !result.checkedMinutes
        ? 'partial'
        : 'consistent';
  const messages = {
    empty: '该交易日尚未保存 Tick',
    warning: '发现序号缺口、累计量异常或分钟成交量不一致，请检查明细',
    partial: '已保存部分 Tick；起始累计量或分钟对账不足，不能确认完整覆盖',
    consistent:
      '已采集区间的累计量与已覆盖分钟 K 线一致；不代表交易所完整逐笔或全天完整',
  };
  return {
    ...result,
    symbol,
    tradingDay,
    checkedAt: new Date().toISOString(),
    state,
    message: messages[state],
  };
}
