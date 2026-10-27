// Calculation port of the user-supplied RSI Pine Script in source.pine.
import type { Bar } from '../../../../shared';
import { movingAverage } from '../../calculations';

type Values = readonly (number | undefined)[];

/** Wilder's RMA seeds from a complete SMA window, unlike EMA's first-value seed. */
export function rma(values: Values, period: number): (number | undefined)[] {
  if (!Number.isSafeInteger(period) || period < 1)
    throw new Error('平滑周期必须是正整数');
  let sum = 0,
    count = 0;
  let average: number | undefined;
  return values.map((value) => {
    if (value === undefined || !Number.isFinite(value)) {
      sum = 0;
      count = 0;
      average = undefined;
      return undefined;
    }
    if (average !== undefined)
      return (average = (average * (period - 1) + value) / period);
    sum += value;
    count++;
    if (count === period) average = sum / period;
    return average;
  });
}

export function relativeStrengthIndex(values: Values, period: number) {
  const changes = values.map((value, index) => {
    const previous = values[index - 1];
    return value === undefined || previous === undefined
      ? undefined
      : value - previous;
  });
  const up = rma(
    changes.map((change) =>
      change === undefined ? undefined : Math.max(change, 0),
    ),
    period,
  );
  const down = rma(
    changes.map((change) =>
      change === undefined ? undefined : Math.max(-change, 0),
    ),
    period,
  );
  return up.map((gain, index) => {
    const loss = down[index];
    if (gain === undefined || loss === undefined) return undefined;
    // Keep the supplied Pine branch order: an entirely flat window yields 100.
    return loss === 0 ? 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss);
  });
}

function weightedAverage(values: Values, period: number) {
  let sum = 0,
    weighted = 0,
    count = 0;
  const denominator = (period * (period + 1)) / 2;
  return values.map((value, index) => {
    if (value === undefined || !Number.isFinite(value)) {
      sum = 0;
      weighted = 0;
      count = 0;
      return undefined;
    }
    if (count < period) {
      count++;
      weighted += count * value;
      sum += value;
    } else {
      weighted += period * value - sum;
      sum += value - values[index - period]!;
    }
    return count >= period ? weighted / denominator : undefined;
  });
}

export function smoothRsi(
  values: Values,
  volumes: readonly number[],
  period: number,
  method: string,
): (number | undefined)[] {
  if (!Number.isSafeInteger(period) || period < 1)
    throw new Error('平滑周期必须是正整数');
  if (method === 'none') return values.map(() => undefined);
  if (method === 'rma') return rma(values, period);
  if (method === 'wma') return weightedAverage(values, period);
  if (method === 'vwma') {
    const weights = values.map((value, index) =>
      value !== undefined &&
      Number.isFinite(value) &&
      Number.isFinite(volumes[index]) &&
      volumes[index] >= 0
        ? volumes[index]
        : undefined,
    );
    const numerator = movingAverage(
      values.map((value, index) =>
        value === undefined || weights[index] === undefined
          ? undefined
          : value * weights[index]!,
      ),
      period,
      'sma',
    );
    const denominator = movingAverage(weights, period, 'sma');
    return numerator.map((value, index) =>
      value === undefined || !denominator[index]
        ? undefined
        : value / denominator[index]!,
    );
  }
  return movingAverage(values, period, method === 'ema' ? 'ema' : 'sma');
}

/** Pine ta.stdev defaults to population standard deviation (biased=true). */
export function rsiStandardDeviation(values: Values, period: number) {
  if (!Number.isSafeInteger(period) || period < 1)
    throw new Error('布林带周期必须是正整数');
  let sum = 0,
    squares = 0,
    count = 0;
  return values.map((value, index) => {
    if (value === undefined || !Number.isFinite(value)) {
      sum = 0;
      squares = 0;
      count = 0;
      return undefined;
    }
    sum += value;
    squares += value * value;
    count++;
    if (count > period) {
      const old = values[index - period]!;
      sum -= old;
      squares -= old * old;
    }
    return count >= period
      ? Math.sqrt(Math.max(0, squares / period - (sum / period) ** 2))
      : undefined;
  });
}

export interface RsiDivergence {
  kind: 'bull' | 'bear';
  from: number;
  to: number;
  fromValue: number;
  toValue: number;
  confirmedIndex: number;
}

export function rsiDivergences(
  bars: readonly Bar[],
  rsi: Values,
): RsiDivergence[] {
  const events: RsiDivergence[] = [];
  let previousLow: number | undefined, previousHigh: number | undefined;
  const isPivot = (index: number, low: boolean) => {
    const value = rsi[index];
    if (value === undefined || !Number.isFinite(value)) return false;
    for (let offset = 1; offset <= 5; offset++) {
      const left = rsi[index - offset],
        right = rsi[index + offset];
      if (
        left === undefined ||
        right === undefined ||
        !Number.isFinite(left) ||
        !Number.isFinite(right)
      )
        return false;
      if (low ? left < value || right <= value : left > value || right >= value)
        return false;
    }
    return true;
  };
  for (let confirmed = 10; confirmed < bars.length; confirmed++) {
    const index = confirmed - 5;
    for (const low of [true, false]) {
      if (!isPivot(index, low)) continue;
      const previous = low ? previousLow : previousHigh;
      // _inRange(plFound[1]) counts from the bar AFTER the previous detection.
      const distance = previous === undefined ? 0 : index - previous - 1;
      if (previous !== undefined && distance >= 5 && distance <= 60) {
        const diverged = low
          ? rsi[index]! > rsi[previous]! && bars[index].low < bars[previous].low
          : rsi[index]! < rsi[previous]! &&
            bars[index].high > bars[previous].high;
        if (diverged)
          events.push({
            kind: low ? 'bull' : 'bear',
            from: previous,
            to: index,
            fromValue: rsi[previous]!,
            toValue: rsi[index]!,
            confirmedIndex: confirmed,
          });
      }
      if (low) previousLow = index;
      else previousHigh = index;
    }
  }
  return events;
}
