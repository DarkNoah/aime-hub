import { pluginRequest } from '@app/plugin-sdk/web';
import { BAR_PAGE_SIZE, type Bar, type BarWindow } from '../../shared';
import { jumpTimestamp } from '../chart-navigation';
import { barLabelTime } from '../chart-time';

export interface ReplaySource {
  pluginId: string;
  path: string;
  duration: number;
  symbol: string;
}

/** Use the same Beijing period-end labels as the chart and date navigation. */
export function replayTimeInput(time: number, duration: number) {
  return new Date((barLabelTime(time, duration) + 8 * 3600) * 1000)
    .toISOString()
    .slice(0, 16);
}

export function parseReplayTime(value: string, duration: number) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('请选择有效的回放日期和时间');
  const time = jumpTimestamp(value.slice(0, 10), value.slice(11), duration);
  if (time === null) throw new Error('请选择有效的回放日期和时间');
  return time;
}

/** Gaps select the preceding candle, never reveal a future candle. */
export function replayStartIndex(bars: readonly Bar[], time: number) {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (bars[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export async function fetchReplayBars(
  source: ReplaySource,
  options: { around?: number; after?: number; limit?: number },
  signal: AbortSignal,
): Promise<Bar[]> {
  const query = new URLSearchParams({
    duration: String(source.duration),
    limit: String(options.limit ?? BAR_PAGE_SIZE),
  });
  if (options.around !== undefined) query.set('around', String(options.around));
  if (options.after !== undefined) query.set('after', String(options.after));
  const result = await pluginRequest<Bar[] | BarWindow>(
    source.pluginId,
    `${source.path}${source.path.includes('?') ? '&' : '?'}${query}`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) },
  );
  const bars = Array.isArray(result) ? result : result.bars;
  if (
    !Array.isArray(bars) ||
    bars.some(
      (bar, index) =>
        bar.symbol !== source.symbol ||
        bar.duration !== source.duration ||
        !Number.isSafeInteger(bar.time) ||
        bar.time <= (options.after ?? 0) ||
        (index > 0 && bar.time <= bars[index - 1].time) ||
        ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(
          Number.isFinite,
        ),
    )
  )
    throw new Error('回放行情数据异常，请重新定位');
  return bars;
}

export function replayError(cause: unknown) {
  if (cause instanceof Error && cause.name === 'TimeoutError')
    return '历史行情读取超时，请重试或在图中点选起点';
  if (
    cause instanceof Error &&
    /^(请选择|所选时间|回放行情)/.test(cause.message)
  )
    return cause.message;
  return '回放历史加载失败，请重试';
}
