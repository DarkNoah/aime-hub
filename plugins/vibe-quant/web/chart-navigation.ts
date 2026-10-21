import { BAR_JUMP_RADIUS, type Bar } from '../shared';
import { barStartTime } from './chart-time';

export type PageDirection = 'before' | 'after';

export function mergeBars(current: Bar[], incoming: Bar[]): Bar[] {
  return [
    ...new Map(
      [...current, ...incoming].map((bar) => [bar.time, bar]),
    ).values(),
  ].sort((a, b) => a.time - b.time);
}

export function jumpTimestamp(
  date: string,
  time: string,
  duration: number,
): number | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    (time && !/^\d{2}:\d{2}$/.test(time))
  )
    return null;
  const value = Date.parse(`${date}T${time || '00:00'}:00+08:00`) / 1000;
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  // Reject normalized dates such as February 30, independently of browser TZ.
  const local = new Date((value + 8 * 3600) * 1000).toISOString();
  if (local.slice(0, 16) !== `${date}T${time || '00:00'}`) return null;
  // A selected time is the chart's end label; date-only searches keep midnight.
  return time ? barStartTime(value, duration) : value;
}

export function centeredRange(bars: Bar[], time: number) {
  const index = bars.findIndex((bar) => bar.time === time);
  return index < 0
    ? null
    : {
        from: index - BAR_JUMP_RADIUS - 0.5,
        to: index + BAR_JUMP_RADIUS + 0.5,
      };
}

export function marketDate(time: number) {
  return new Date((time + 8 * 3600) * 1000).toISOString().slice(0, 10);
}
