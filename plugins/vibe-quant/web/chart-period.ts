import { DURATIONS, type Bar } from '../shared';

export type ChartPeriod = (typeof DURATIONS)[number] | 'intraday';
export const CHART_PERIOD_STORAGE_KEY = 'vibe-quant:chart-period:v1';

export function parseChartPeriod(value: string | null): ChartPeriod {
  if (value === 'intraday') return value;
  return DURATIONS.find((duration) => String(duration) === value) ?? 60;
}

export function readChartPeriod(): ChartPeriod {
  try {
    return parseChartPeriod(localStorage.getItem(CHART_PERIOD_STORAGE_KEY));
  } catch {
    return 60;
  }
}

export function saveChartPeriod(period: ChartPeriod): boolean {
  try {
    localStorage.setItem(CHART_PERIOD_STORAGE_KEY, String(period));
    return true;
  } catch {
    return false;
  }
}

/** Use the latest daily bar's start to keep a futures night session with its day session. */
export function intradayBars(minutes: Bar[], daily: Bar[]): Bar[] {
  const latest = minutes.at(-1);
  if (!latest) return [];
  const start = daily.findLast((bar) => bar.time <= latest.time)?.time;
  const calendarStart =
    Math.floor((latest.time + 8 * 3600) / 86400) * 86400 - 8 * 3600;
  return minutes.filter((bar) => bar.time >= (start ?? calendarStart));
}
