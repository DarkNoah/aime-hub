import type { Bar } from '../../shared';
import type { IndicatorParameter, IndicatorPoint } from './types';

export const priceSourceParameter: IndicatorParameter = {
  key: 'priceSource',
  label: '价格来源',
  type: 'select',
  default: 'close',
  options: [
    { value: 'close', label: '收盘价' },
    { value: 'open', label: '开盘价' },
    { value: 'high', label: '最高价' },
    { value: 'low', label: '最低价' },
    { value: 'hl2', label: '高低均价 (H+L)/2' },
    { value: 'hlc3', label: '典型价格 (H+L+C)/3' },
    { value: 'ohlc4', label: '四价均值 (O+H+L+C)/4' },
  ],
};

export const averageOptions = [
  { value: 'sma', label: 'SMA 简单移动平均' },
  { value: 'ema', label: 'EMA 指数移动平均' },
] as const;

export function priceValues(bars: readonly Bar[], source: string): number[] {
  return bars.map((bar) => {
    switch (source) {
      case 'open':
        return bar.open;
      case 'high':
        return bar.high;
      case 'low':
        return bar.low;
      case 'hl2':
        return (bar.high + bar.low) / 2;
      case 'hlc3':
        return (bar.high + bar.low + bar.close) / 3;
      case 'ohlc4':
        return (bar.open + bar.high + bar.low + bar.close) / 4;
      default:
        return bar.close;
    }
  });
}

/** EMA starts at the first available value. SMA needs a full consecutive window. */
export function movingAverage(
  values: readonly (number | undefined)[],
  period: number,
  method: string,
): (number | undefined)[] {
  if (!Number.isSafeInteger(period) || period < 1) {
    throw new Error('均线周期必须是正整数');
  }
  let sum = 0;
  let count = 0;
  let ema: number | undefined;
  const alpha = 2 / (period + 1);
  return values.map((value, index) => {
    if (value === undefined || !Number.isFinite(value)) {
      sum = 0;
      count = 0;
      ema = undefined;
      return undefined;
    }
    if (method === 'ema') {
      ema = ema === undefined ? value : alpha * value + (1 - alpha) * ema;
      return ema;
    }
    sum += value;
    count += 1;
    if (count > period) sum -= values[index - period]!;
    return count >= period ? sum / period : undefined;
  });
}

export function points(
  bars: readonly Bar[],
  values: readonly (number | undefined)[],
): IndicatorPoint[] {
  return bars.map((bar, index) => {
    const value = values[index];
    return value === undefined || !Number.isFinite(value)
      ? { time: bar.time }
      : { time: bar.time, value };
  });
}
