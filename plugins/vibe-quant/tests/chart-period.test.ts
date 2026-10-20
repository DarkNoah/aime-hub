import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bar } from '../shared.js';
import { intradayBars, parseChartPeriod } from '../web/chart-period.js';

const bar = (date: string, duration = 60): Bar => ({
  symbol: 'CFFEX.IM2611',
  duration,
  time: Date.parse(`${date}+08:00`) / 1000,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 100,
});

test('view preference restores supported views and repairs invalid stored values', () => {
  assert.equal(parseChartPeriod('intraday'), 'intraday');
  assert.equal(parseChartPeriod('180'), 180);
  assert.equal(parseChartPeriod('2592000'), 2592000);
  for (const value of [null, '', 'undefined', 'null', '{}', '0', 'NaN', '120'])
    assert.equal(parseChartPeriod(value), 60);
});

test('intraday selects the last available trading session, including after market close', () => {
  const previous = bar('2026-10-16T15:00:00');
  const opening = bar('2026-10-19T09:30:00');
  const closing = bar('2026-10-19T15:00:00');
  const minutes = [previous, opening, closing];
  assert.deepEqual(
    intradayBars(minutes, [
      bar('2026-10-16T00:00:00', 86400),
      bar('2026-10-19T00:00:00', 86400),
    ]),
    [opening, closing],
  );
  assert.deepEqual(intradayBars(minutes, []), [opening, closing]);
  assert.deepEqual(intradayBars([], []), []);
});

test('night and following day sessions stay together across midnight and a weekend', () => {
  const previous = bar('2026-10-16T15:00:00');
  const night = bar('2026-10-16T21:00:00');
  const overnight = bar('2026-10-17T01:30:00');
  const monday = bar('2026-10-19T09:00:00');
  const daily = [
    bar('2026-10-15T21:00:00', 86400),
    bar('2026-10-16T21:00:00', 86400),
  ];
  assert.deepEqual(intradayBars([previous, night, overnight, monday], daily), [
    night,
    overnight,
    monday,
  ]);
  const nextNight = bar('2026-10-19T21:00:00');
  assert.deepEqual(
    intradayBars(
      [night, overnight, monday, nextNight],
      [...daily, bar('2026-10-19T21:00:00', 86400)],
    ),
    [nextNight],
  );
});
