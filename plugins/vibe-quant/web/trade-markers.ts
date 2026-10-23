import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import type { Trade, TradeReplay } from '../strategy-types';
import { tradeExitAnchor } from '../strategy-types';
import { exitMarkerLabel } from './trade-exit';
import { MONTH_DURATION, type Bar } from '../shared';
import { barLabelTime } from './chart-time';
import { pricePrecision } from './readout-format';

/** Match a fill to the candle interval provided by the market data source. */
export function tradeCandleTime(time: number, bars: Bar[], duration: number) {
  const index = bars.findLastIndex((bar) => bar.time <= time);
  if (index < 0) return null;
  const bar = bars[index];
  const local = new Date((bar.time + 8 * 3600) * 1000);
  const end =
    duration >= 86400 && bars[index + 1]
      ? bars[index + 1].time
      : duration === MONTH_DURATION
        ? Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) / 1000 -
          8 * 3600
        : bar.time + duration;
  return time < end ? bar.time : null;
}

export function tradeMarkers(
  trade: Trade,
  bars: Bar[],
  duration: number,
  priceTick = 0.01,
  markerTimes?: TradeReplay['markerTimes'],
): SeriesMarker<UTCTimestamp>[] {
  const times = new Set(bars.map((bar) => bar.time));
  const price = (value: number) => value.toFixed(pricePrecision(priceTick));
  const long = trade.side === 'long';
  return [
    {
      time: markerTimes
        ? markerTimes.entry
        : tradeCandleTime(trade.entry_time, bars, duration),
      position: long ? 'belowBar' : 'aboveBar',
      shape: long ? 'arrowUp' : 'arrowDown',
      color: '#2563eb',
      text: `入场 ${price(trade.entry_price)}`,
    },
    {
      time: markerTimes
        ? markerTimes.exit
        : tradeCandleTime(tradeExitAnchor(trade), bars, duration),
      position: long ? 'aboveBar' : 'belowBar',
      shape: long ? 'arrowDown' : 'arrowUp',
      color: '#d97706',
      text: `${exitMarkerLabel(trade.exit_reason)} ${price(trade.exit_price)}`,
    },
  ]
    .filter((marker) => marker.time !== null && times.has(marker.time))
    .map((marker) => ({
      ...marker,
      time: barLabelTime(marker.time!, duration) as UTCTimestamp,
    })) as SeriesMarker<UTCTimestamp>[];
}
