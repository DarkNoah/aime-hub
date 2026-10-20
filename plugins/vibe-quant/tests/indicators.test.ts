import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bar } from '../shared';
import { movingAverage, priceValues } from '../web/indicators/calculations';
import { maIndicator } from '../web/indicators/main/ma';
import { macdIndicator } from '../web/indicators/sub/macd';
import { volumeIndicator } from '../web/indicators/sub/volume';
import {
  defaultParameters,
  parsePreferences,
  validateParameters,
} from '../web/indicators/preferences';

const bars = (values: number[]): Bar[] =>
  values.map((close, index) => ({
    symbol: 'TEST',
    duration: 60,
    time: 1700000000 + index * 60,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 100 + index,
  }));

function near(actual: number | undefined, expected: number) {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-10,
    `${actual} ≠ ${expected}`,
  );
}

test('SMA waits for a full window; EMA seeds from the first price and resets across gaps', () => {
  assert.deepEqual(movingAverage([1, 2, 3, 4, 5], 3, 'sma'), [
    undefined,
    undefined,
    2,
    3,
    4,
  ]);
  assert.deepEqual(
    movingAverage([1, 2, 3, 4], 3, 'ema'),
    [1, 1.5, 2.25, 3.125],
  );
  assert.deepEqual(movingAverage([1, 2, undefined, 8, 10], 2, 'sma'), [
    undefined,
    1.5,
    undefined,
    undefined,
    9,
  ]);
  assert.deepEqual(movingAverage([1, NaN, 5], 2, 'ema'), [1, undefined, 5]);
  assert.deepEqual(movingAverage([], 1, 'sma'), []);
  assert.throws(() => movingAverage([1], 0, 'sma'));
});

test('MA honors parameters, preserves warm-up times and recalculates revised/prepended bars', () => {
  const parameters = { ...defaultParameters(maIndicator), period: 3 };
  const data = bars([2, 4, 6, 8]);
  const [plot] = maIndicator.render(data, parameters);
  assert.deepEqual(plot.data, [
    { time: data[0].time },
    { time: data[1].time },
    { time: data[2].time, value: 4 },
    { time: data[3].time, value: 6 },
  ]);
  const revised = data.map((bar, index) =>
    index === 3 ? { ...bar, close: 14 } : bar,
  );
  assert.equal(
    maIndicator.render(revised, parameters)[0].data.at(-1)?.value,
    8,
  );
  const prepended = [
    { ...data[0], time: data[0].time - 60, close: 0 },
    ...data,
  ];
  assert.equal(maIndicator.render(prepended, parameters)[0].data[2].value, 2);
  assert.equal(
    maIndicator.render(data, { ...parameters, priceSource: 'open' })[0].data[2]
      .value,
    3,
  );
  assert.equal(
    maIndicator
      .render(data, { ...parameters, period: 10 })[0]
      .data.every((point) => point.value === undefined),
    true,
  );
  assert.deepEqual(maIndicator.render([], parameters)[0].data, []);
});

test('all configured price sources read the current OHLC values', () => {
  const data = bars([10]);
  assert.deepEqual(priceValues(data, 'open'), [9]);
  assert.deepEqual(priceValues(data, 'high'), [12]);
  assert.deepEqual(priceValues(data, 'low'), [8]);
  assert.deepEqual(priceValues(data, 'hl2'), [10]);
  assert.deepEqual(priceValues(data, 'hlc3'), [10]);
  assert.deepEqual(priceValues(data, 'ohlc4'), [9.75]);
});

test('MACD matches a hand-calculated EMA sequence and uses unscaled MACD minus signal histogram', () => {
  const parameters = {
    ...defaultParameters(macdIndicator),
    fastPeriod: 2,
    slowPeriod: 3,
    signalPeriod: 2,
  };
  const plots = macdIndicator.render(bars([1, 2, 3, 4]), parameters);
  const macd = plots.find((plot) => plot.id === 'macd')!.data;
  const signal = plots.find((plot) => plot.id === 'signal')!.data;
  const histogram = plots.find((plot) => plot.id === 'histogram')!.data;
  near(macd[1].value, 1 / 6);
  near(macd[2].value, 11 / 36);
  near(macd[3].value, 85 / 216);
  near(signal[1].value, 1 / 9);
  near(signal[2].value, 13 / 54);
  near(signal[3].value, 37 / 108);
  near(histogram[1].value, 1 / 18);
  near(histogram[2].value, 7 / 108);
  near(histogram[3].value, 11 / 216);
  assert.equal(histogram[3].color, parameters.positiveColor);
  const falling = macdIndicator.render(bars([4, 3, 2, 1]), parameters)[0];
  assert.equal(falling.data.at(-1)?.color, parameters.negativeColor);
});

test('MACD supports SMA warm-up and flat series without NaN or invented values', () => {
  const parameters = {
    ...defaultParameters(macdIndicator),
    fastPeriod: 2,
    slowPeriod: 3,
    signalPeriod: 2,
    method: 'sma',
    signalMethod: 'sma',
  };
  const plots = macdIndicator.render(bars([5, 5, 5, 5, 5]), parameters);
  assert.deepEqual(
    plots[1].data.map((point) => point.value),
    [undefined, undefined, 0, 0, 0],
  );
  assert.deepEqual(
    plots[2].data.map((point) => point.value),
    [undefined, undefined, undefined, 0, 0],
  );
  assert.ok(
    macdIndicator
      .render([], parameters)
      .every((plot) => plot.data.length === 0),
  );
});

test('volume retains source units and configurable up/down colors', () => {
  const parameters = defaultParameters(volumeIndicator);
  const data = bars([5, 7]);
  data[1].open = 8;
  const points = volumeIndicator.render(data, parameters)[0].data;
  assert.equal(points[0].value, 100);
  assert.equal(points[0].color, parameters.upColor);
  assert.equal(points[1].color, parameters.downColor);
});

test('storage round-trips visibility and parameters; old/invalid fields fall back safely', () => {
  const preferences = parsePreferences(null);
  preferences.ma.visible = false;
  preferences.ma.parameters.period = 50;
  preferences.macd.parameters.signalPeriod = 5;
  assert.deepEqual(parsePreferences(JSON.stringify(preferences)), preferences);
  for (const invalid of ['bad json', 'null', '[]', '"value"']) {
    assert.deepEqual(parsePreferences(invalid), parsePreferences(null));
  }
  const repaired = parsePreferences(
    JSON.stringify({
      ma: {
        visible: false,
        parameters: {
          period: 0,
          method: 'invalid',
          color: 'red',
          lineWidth: 99,
          unexpected: true,
        },
      },
      macd: { visible: 'yes', parameters: { fastPeriod: 100, slowPeriod: 5 } },
      unknown: { visible: true },
    }),
  );
  assert.equal(repaired.ma.visible, false);
  assert.deepEqual(repaired.ma.parameters, defaultParameters(maIndicator));
  assert.deepEqual(repaired.macd.parameters, defaultParameters(macdIndicator));
  assert.equal(Object.hasOwn(repaired, 'unknown'), false);
});

test('settings reject empty/fractional periods and invalid cross-field combinations', () => {
  for (const period of ['', NaN, Infinity, -1, 0, 2.5]) {
    assert.ok(
      validateParameters(maIndicator, {
        ...defaultParameters(maIndicator),
        period,
      }),
    );
  }
  assert.match(
    validateParameters(macdIndicator, {
      ...defaultParameters(macdIndicator),
      fastPeriod: 26,
    })!,
    /快线周期/,
  );
  assert.equal(
    validateParameters(maIndicator, {
      ...defaultParameters(maIndicator),
      period: 20000,
    }),
    undefined,
  );
});
