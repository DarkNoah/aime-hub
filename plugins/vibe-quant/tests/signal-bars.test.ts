import assert from 'node:assert/strict';
import test from 'node:test';
import { completeFiveMinuteBars } from '../server/strategies/signal-bars.js';
import type { Bar } from '../shared.js';

const bars: Bar[] = Array.from({ length: 15 }, (_, i) => ({
  symbol: 'KQ.m@CFFEX.IM',
  duration: 60,
  time: 1800 + i * 60,
  open: 100 + i,
  high: 110 + i,
  low: 90 + i,
  close: 105 + i,
  volume: 10,
  amount: 100,
}));
test('five-minute signals require complete groups and share minute execution prices', () => {
  const existing = { ...bars[5], duration: 300, high: 999 };
  const derived = completeFiveMinuteBars(
    [...bars.slice().reverse(), existing],
    bars[0].symbol,
    2700,
  );
  assert.deepEqual(
    derived.map((b) => b.time),
    [1800, 2100, 2400],
  );
  assert.equal(derived[1].high, 119);
  assert.deepEqual(derived[0], {
    symbol: bars[0].symbol,
    duration: 300,
    time: 1800,
    open: 100,
    high: 114,
    low: 90,
    close: 109,
    volume: 50,
    amount: 500,
  });
  assert.equal(
    completeFiveMinuteBars(
      bars.filter((b) => b.time !== 1920),
      bars[0].symbol,
      2100,
    ).length,
    0,
  );
  assert.equal(completeFiveMinuteBars(bars, bars[0].symbol, 2099).length, 0);
  assert.equal(completeFiveMinuteBars(bars, 'another', 2700).length, 0);
  assert.equal(
    completeFiveMinuteBars([...bars, bars[0]], bars[0].symbol, 2100)[0].volume,
    50,
  );
});
