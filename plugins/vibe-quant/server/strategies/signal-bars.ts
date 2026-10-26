import type { Bar } from '../../shared.js';

/** Keep five-minute signals on the same price series as minute-level execution. */
export function completeFiveMinuteBars(
  bars: Bar[],
  symbol: string,
  end: number,
): Bar[] {
  const minutes = new Map(
    bars
      .filter((b) => b.symbol === symbol && b.duration === 60)
      .map((b) => [b.time, b]),
  );
  const result: Bar[] = [];
  for (const [time, first] of minutes) {
    if (time % 300 || time + 300 > end) continue;
    const parts = Array.from({ length: 5 }, (_, index) =>
      minutes.get(time + index * 60),
    );
    if (parts.some((part) => !part)) continue;
    const complete = parts as Bar[];
    result.push({
      ...first,
      duration: 300,
      high: Math.max(...complete.map((b) => b.high)),
      low: Math.min(...complete.map((b) => b.low)),
      close: complete[4].close,
      volume: complete.reduce((sum, b) => sum + b.volume, 0),
      amount: complete.every(
        (b) => b.amount != null && Number.isFinite(b.amount),
      )
        ? complete.reduce((sum, b) => sum + b.amount!, 0)
        : null,
    });
  }
  return result.sort((a, b) => a.time - b.time);
}
