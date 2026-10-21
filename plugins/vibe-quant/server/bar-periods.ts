import { MONTH_DURATION, type Bar } from '../shared.js';

const SHANGHAI_OFFSET = 8 * 3600;

export function derivedPeriod(duration: number, limit = 1000) {
  if (duration === 180) return { source: 60, limit: limit * 3 + 1 };
  if (duration === MONTH_DURATION)
    return { source: 86400, limit: limit * 31 + 1 };
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

export function nextPeriodStart(time: number, duration: number) {
  if (duration !== MONTH_DURATION)
    return periodStart(time, duration) + duration;
  const local = new Date((time + SHANGHAI_OFFSET) * 1000);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) / 1000 -
    SHANGHAI_OFFSET
  );
}

/** Input is one symbol's chronological, deduplicated source bars. */
export function aggregateBars(
  bars: Bar[],
  duration: number,
  limit = 1000,
  forward = false,
): Bar[] {
  const result: Bar[] = [];
  for (const bar of bars) {
    const time = periodStart(bar.time, duration);
    const previous = result.at(-1);
    if (previous?.time === time) {
      previous.high = Math.max(previous.high, bar.high);
      previous.low = Math.min(previous.low, bar.low);
      previous.close = bar.close;
      previous.volume += bar.volume;
      if (previous.amount !== undefined || bar.amount !== undefined)
        previous.amount =
          previous.amount != null &&
          bar.amount != null &&
          Number.isFinite(previous.amount) &&
          Number.isFinite(bar.amount)
            ? previous.amount + bar.amount
            : null;
    } else {
      result.push({ ...bar, duration, time });
    }
  }
  // The source query includes an extra bar so the truncated edge period is
  // outside the returned page, in either query direction.
  return forward ? result.slice(0, limit) : result.slice(-limit);
}
