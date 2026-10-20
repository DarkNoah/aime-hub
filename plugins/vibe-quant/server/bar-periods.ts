import { MONTH_DURATION, type Bar } from '../shared.js';

const SHANGHAI_OFFSET = 8 * 3600;

export function derivedPeriod(duration: number) {
  if (duration === 180) return { source: 60, limit: 3001 };
  if (duration === MONTH_DURATION) return { source: 86400, limit: 31001 };
  return undefined;
}

export function periodStart(time: number, duration: number) {
  if (duration !== MONTH_DURATION)
    return Math.floor(time / duration) * duration;
  const local = new Date((time + SHANGHAI_OFFSET) * 1000);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) / 1000 -
    SHANGHAI_OFFSET
  );
}

/** Input is one symbol's chronological, deduplicated source bars. */
export function aggregateBars(bars: Bar[], duration: number): Bar[] {
  const result: Bar[] = [];
  for (const bar of bars) {
    const time = periodStart(bar.time, duration);
    const previous = result.at(-1);
    if (previous?.time === time) {
      previous.high = Math.max(previous.high, bar.high);
      previous.low = Math.min(previous.low, bar.low);
      previous.close = bar.close;
      previous.volume += bar.volume;
    } else {
      result.push({ ...bar, duration, time });
    }
  }
  // The source query allows an extra bar beyond 1000 full target periods,
  // so a source-limit-truncated first period cannot enter the returned page.
  return result.slice(-1000);
}
