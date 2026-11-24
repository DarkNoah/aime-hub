import { CHART_DURATIONS } from './shared.js';

export interface MarketChartTarget {
  symbol: string;
  time: number;
  duration: number;
  monitor?: string;
}

export interface MarketViewTarget {
  symbol: string;
  time?: number;
  duration?: number | 'intraday';
  monitor?: string;
}

export function marketSearch(target: MarketViewTarget) {
  const query = new URLSearchParams({ symbol: target.symbol });
  if (target.time !== undefined)
    query.set('time', String(Math.floor(target.time)));
  if (target.duration !== undefined)
    query.set('duration', String(target.duration));
  if (target.monitor) query.set('monitor', target.monitor);
  return `?${query}`;
}

export function marketPageUrl(target: MarketViewTarget) {
  return `/vibe-quant${marketSearch(target)}`;
}

/** Notification publishing expects the plugin-scoped path. */
export function marketChartUrl(target: MarketChartTarget) {
  return `/plugins/vibe-quant/${marketSearch(target)}`;
}

export function readMarketChartTarget(search: string): MarketViewTarget | null {
  const query = new URLSearchParams(search);
  const symbol = query.get('symbol');
  if (!symbol || !/^[A-Za-z0-9_.@-]{1,100}$/.test(symbol)) return null;
  const time = query.has('time') ? Number(query.get('time')) : undefined;
  if (time !== undefined && (!Number.isSafeInteger(time) || time <= 0))
    return null;
  const monitor = query.get('monitor') || undefined;
  if (monitor && time === undefined) return null;
  const rawPeriod = query.get('duration');
  const duration =
    rawPeriod === 'intraday'
      ? 'intraday'
      : CHART_DURATIONS.find((value) => String(value) === rawPeriod);
  return {
    symbol,
    ...(time === undefined ? {} : { time }),
    ...(duration === undefined && time === undefined
      ? {}
      : { duration: duration ?? 60 }),
    monitor,
  };
}
