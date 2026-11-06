import { CHART_DURATIONS } from './shared.js';

export interface MarketChartTarget {
  symbol: string;
  time: number;
  duration: number;
  monitor?: string;
}

export function marketChartUrl(target: MarketChartTarget) {
  const query = new URLSearchParams({
    symbol: target.symbol,
    time: String(Math.floor(target.time)),
    duration: String(target.duration),
  });
  if (target.monitor) query.set('monitor', target.monitor);
  return `/plugins/vibe-quant/?${query}`;
}

export function readMarketChartTarget(
  search: string,
): MarketChartTarget | null {
  const query = new URLSearchParams(search);
  const symbol = query.get('symbol');
  const time = Number(query.get('time'));
  const duration = Number(query.get('duration'));
  if (!symbol || !Number.isSafeInteger(time) || time <= 0) return null;
  return {
    symbol,
    time,
    duration: CHART_DURATIONS.find((value) => value === duration) ?? 60,
    monitor: query.get('monitor') || undefined,
  };
}
