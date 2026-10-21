import assert from 'node:assert/strict';
import test from 'node:test';
import { MONTH_DURATION } from '../shared.js';
import { barLabelTime } from '../web/chart-time.js';
import {
  pricePrecision,
  readoutQuantity,
  readoutTime,
} from '../web/readout-format.js';

test('candle timestamps are displayed in Shanghai time including day boundaries', () => {
  assert.equal(
    readoutTime(Date.parse('2026-10-20T17:30:00Z') / 1000),
    '2026-10-21 01:30',
  );
  assert.equal(readoutTime(0), '1970-01-01 08:00');
  assert.equal(readoutTime(undefined), '—');
});

test('minute labels use candle ends across session and midnight boundaries', () => {
  for (const [start, duration, label] of [
    ['2026-10-20T09:30', 60, '2026-10-20 09:31'],
    ['2026-10-20T11:29', 60, '2026-10-20 11:30'],
    ['2026-10-20T13:00', 60, '2026-10-20 13:01'],
    ['2026-10-20T14:59', 60, '2026-10-20 15:00'],
    ['2026-10-20T23:59', 60, '2026-10-21 00:00'],
    ['2026-10-20T09:30', 180, '2026-10-20 09:33'],
    ['2026-10-20T09:30', 300, '2026-10-20 09:35'],
    ['2026-10-20T09:30', 900, '2026-10-20 09:45'],
    ['2026-10-20T09:30', 1800, '2026-10-20 10:00'],
    ['2026-10-20T09:30', 3600, '2026-10-20 10:30'],
  ] as const) {
    const time = Date.parse(`${start}:00+08:00`) / 1000;
    assert.equal(readoutTime(barLabelTime(time, duration)), label);
  }
});

test('daily and calendar-month labels retain their dates', () => {
  const time = Date.parse('2026-10-01T00:00:00+08:00') / 1000;
  for (const duration of [86400, MONTH_DURATION])
    assert.equal(barLabelTime(time, duration), time);
});

test('readout preserves tick precision and distinguishes missing turnover from zero', () => {
  assert.equal(pricePrecision(0.2), 1);
  assert.equal(pricePrecision(0.001), 3);
  assert.equal(pricePrecision(1e-7), 7);
  assert.equal(pricePrecision(1), 0);
  assert.equal(pricePrecision(NaN), 2);
  assert.equal(readoutQuantity(0, true), '0元');
  assert.equal(readoutQuantity(123456789, true), '1.23亿元');
  for (const missing of [undefined, null, NaN, Infinity, -1]) {
    assert.equal(readoutQuantity(missing, true), '—');
  }
});
