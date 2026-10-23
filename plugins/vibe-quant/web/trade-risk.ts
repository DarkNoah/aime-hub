import { MONTH_DURATION, type Bar } from '../shared';
import type { RiskLevelRecord, Trade } from '../strategy-types';
import type { IndicatorDrawing } from './indicators/types';
import { pricePrecision } from './readout-format';

/** Stable ordering preserves the last calculation when several share a timestamp. */
export function tradeRiskLevels(
  trade: Trade,
  records: readonly RiskLevelRecord[],
) {
  const selected = records
    .filter(
      (record) =>
        record.symbol === trade.symbol &&
        record.entry_signal_id === trade.entry_signal_id &&
        record.time <= trade.exit_time,
    )
    .sort((a, b) => a.time - b.time);
  // Once triggered, the remaining market close retains that snapshot even if
  // the strategy keeps calculating while waiting on volume/T+1.
  const triggered = selected.findIndex(
    (record) => record.id === trade.risk_level_id,
  );
  return triggered < 0 ? selected : selected.slice(0, triggered + 1);
}

function windowEnd(bars: Bar[], duration: number) {
  const last = bars.at(-1)!;
  if (duration !== MONTH_DURATION) return last.time + duration;
  const local = new Date((last.time + 8 * 3600) * 1000);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) / 1000 -
    8 * 3600
  );
}

/** Fractional logical positions retain intrabar changes without inventing candles. */
function logicalTime(time: number, bars: Bar[], duration: number) {
  let low = 0,
    high = bars.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (bars[mid].time <= time) low = mid + 1;
    else high = mid;
  }
  const index = Math.max(0, low - 1);
  const end =
    duration >= 86400
      ? (bars[index + 1]?.time ?? windowEnd(bars, duration))
      : Math.min(
          bars[index + 1]?.time ?? Infinity,
          bars[index].time + duration,
        );
  return (
    index +
    Math.max(
      0,
      Math.min(1, (time - bars[index].time) / (end - bars[index].time)),
    )
  );
}

/** A snapshot only applies forward, until its replacement or the actual exit. */
export function tradeRiskDrawings(
  trade: Trade,
  records: readonly RiskLevelRecord[],
  bars: Bar[],
  duration: number,
  priceTick = 0.01,
): IndicatorDrawing[] {
  if (!bars.length) return [];
  // Only the final calculation at a timestamp has a nonzero chart interval.
  records = records.filter(
    (record, index) => record.time !== records[index + 1]?.time,
  );
  const drawings: IndicatorDrawing[] = [];
  const lastLines = new Map<string, IndicatorDrawing>();
  const end = windowEnd(bars, duration);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const startTime = Math.max(trade.entry_time, record.time, bars[0].time);
    const endTime = Math.min(
      trade.exit_time,
      records[i + 1]?.time ?? Infinity,
      end,
    );
    if (startTime >= endTime) continue;
    const from = logicalTime(startTime, bars, duration);
    const to = logicalTime(endTime, bars, duration);
    if (from >= to) continue;
    for (const [key, color] of [
      ['take_profit', '#dc4c5c'],
      ['stop_loss', '#16a085'],
    ] as const) {
      const price = record[key];
      if (price === null || !Number.isFinite(price)) continue;
      drawings.push({
        id: `${record.id}:${key}:area`,
        kind: 'box',
        from,
        to,
        top: Math.max(trade.entry_price, price),
        bottom: Math.min(trade.entry_price, price),
        color: `${color}20`,
      });
      const line: IndicatorDrawing = {
        id: `${record.id}:${key}:line`,
        kind: 'line',
        from,
        to,
        top: price,
        bottom: price,
        color,
        lineWidth: 2,
      };
      drawings.push(line);
      lastLines.set(key, line);
      const prior = records[i - 1]?.[key];
      if (prior != null && prior !== price && record.time === startTime) {
        drawings.push({
          id: `${record.id}:${key}:step`,
          kind: 'line',
          from,
          to: from,
          top: prior,
          bottom: price,
          color,
          style: 'dotted',
        });
      }
    }
  }
  for (const [key, line] of lastLines) {
    const other = lastLines.get(
      key === 'take_profit' ? 'stop_loss' : 'take_profit',
    );
    line.text = `${key === 'take_profit' ? '止盈' : '止损'} ${line.top.toFixed(pricePrecision(priceTick))}`;
    line.labelIndex = line.to;
    line.align = !other || line.top >= other.top ? 'above' : 'below';
    line.size = 'small';
  }
  return drawings;
}
