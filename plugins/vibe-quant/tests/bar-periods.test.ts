import assert from 'node:assert/strict';
import test from 'node:test';
import { MONTH_DURATION, type Bar } from '../shared.js';
import { aggregateBars, periodStart } from '../server/bar-periods.js';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';

const timestamp = (date: string) => Date.parse(`${date}+08:00`) / 1000;
const makeBar = (date: string, values: Partial<Bar> = {}): Bar => ({
  symbol: 'SSE.600000',
  duration: 60,
  time: timestamp(date),
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 100,
  ...values,
});

test('3-minute bars preserve OHLCV and leave session breaks empty', () => {
  const bars = [
    makeBar('2026-10-19T09:30:00'),
    makeBar('2026-10-19T09:31:00', { high: 14, low: 8, close: 12, volume: 20 }),
    makeBar('2026-10-19T09:32:00', { close: 13, volume: 30 }),
    makeBar('2026-10-19T09:33:00'),
    makeBar('2026-10-19T11:29:00'),
    makeBar('2026-10-19T13:00:00'),
  ];
  const original = structuredClone(bars);
  const result = aggregateBars(bars, 180);
  assert.deepEqual(result[0], {
    ...bars[0],
    duration: 180,
    high: 14,
    low: 8,
    close: 13,
    volume: 150,
  });
  assert.deepEqual(
    result.map((bar) => bar.time),
    [
      timestamp('2026-10-19T09:30:00'),
      timestamp('2026-10-19T09:33:00'),
      timestamp('2026-10-19T11:27:00'),
      timestamp('2026-10-19T13:00:00'),
    ],
  );
  assert.deepEqual(bars, original);
});

test('monthly bars follow Shanghai calendar months across leap days and years', () => {
  const bars = [
    makeBar('2023-12-29T00:00:00', { duration: 86400 }),
    makeBar('2024-01-02T00:00:00', { duration: 86400 }),
    makeBar('2024-02-01T00:00:00', { duration: 86400 }),
    makeBar('2024-02-29T00:00:00', { duration: 86400, close: 15, high: 15 }),
    makeBar('2024-03-01T00:00:00', { duration: 86400 }),
  ];
  const result = aggregateBars(bars, MONTH_DURATION);
  assert.deepEqual(
    result.map((bar) => bar.time),
    [
      timestamp('2023-12-01T00:00:00'),
      timestamp('2024-01-01T00:00:00'),
      timestamp('2024-02-01T00:00:00'),
      timestamp('2024-03-01T00:00:00'),
    ],
  );
  assert.equal(result[2].volume, 200);
  assert.equal(result[2].close, 15);
  assert.equal(
    periodStart(timestamp('2024-03-01T00:00:00'), MONTH_DURATION),
    result[3].time,
  );
});

const config = {
  engine: 'tdx',
  clickhouseUrl: 'http://127.0.0.1:8123',
  clickhouseDatabase: 'vibe_quant',
  clickhouseUser: 'reader',
  clickhousePassword: 'fixture',
  tdxServers: '127.0.0.1:7709',
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 2,
  pollSeconds: 5,
  historyBars: 1000,
  maxSubscriptions: 100,
};

test('store derives periods after live deduplication and scopes source queries and pagination', async () => {
  const original = globalThis.fetch;
  const daily = makeBar('2024-02-01T00:00:00', { duration: 86400 });
  const nextDaily = makeBar('2024-03-01T00:00:00', { duration: 86400 });
  const minute = makeBar('2024-03-01T09:30:00');
  const saved = [daily, nextDaily, minute];
  const calls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const params = url.searchParams;
    const data =
      params.get('param_engine') === 'tdx'
        ? saved
            .filter(
              (bar) =>
                bar.symbol === params.get('param_symbol') &&
                bar.duration === Number(params.get('param_duration')) &&
                bar.time < Number(params.get('param_before')),
            )
            .sort((a, b) => b.time - a.time)
        : [];
    return Response.json({ data });
  };
  try {
    const store = new MarketStore(
      parseConfig({ ...config, clickhouseReadOnly: true }),
    );
    await store.write(
      'tdx',
      [],
      [
        { ...daily, close: 12, volume: 120 },
        makeBar('2024-02-29T00:00:00', {
          duration: 86400,
          close: 14,
          high: 14,
        }),
        { ...minute, close: 12, volume: 120 },
        makeBar('2024-03-01T09:31:00', { close: 13, high: 13 }),
      ],
    );
    const monthly = await store.bars('tdx', daily.symbol, MONTH_DURATION);
    assert.equal(monthly.length, 2);
    assert.equal(monthly[0].volume, 220);
    assert.equal(monthly[0].close, 14);
    assert.equal(calls.at(-1)?.searchParams.get('param_duration'), '86400');
    assert.equal(calls.at(-1)?.searchParams.get('param_limit'), '31001');
    assert.deepEqual(
      await store.bars('tdx', daily.symbol, MONTH_DURATION, nextDaily.time),
      [monthly[0]],
    );
    const threeMinute = await store.bars('tdx', minute.symbol, 180);
    assert.equal(threeMinute.length, 1);
    assert.equal(threeMinute[0].volume, 220);
    assert.equal(threeMinute[0].close, 13);
    assert.equal(calls.at(-1)?.searchParams.get('param_duration'), '60');
    assert.equal(calls.at(-1)?.searchParams.get('param_limit'), '3001');
    assert.deepEqual(
      await store.bars('tdx', minute.symbol, 180, minute.time + 60),
      [],
    );
    assert.deepEqual(await store.bars('tqsdk', minute.symbol, 180), []);
    assert.deepEqual(await store.bars('tdx', 'SSE.000852', MONTH_DURATION), []);
    assert.deepEqual(
      await store.bars('tdx', daily.symbol, MONTH_DURATION, 1),
      [],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('1000-bar pages exclude a source-limit-truncated first period and do not skip older groups', async () => {
  const original = globalThis.fetch;
  const start = timestamp('2024-01-01T09:30:00');
  const source = Array.from({ length: 3600 }, (_, i) =>
    makeBar('2024-01-01T09:30:00', { time: start + i * 60 }),
  );
  globalThis.fetch = async (input) => {
    const params = new URL(String(input)).searchParams;
    return Response.json({
      data: source
        .filter((bar) => bar.time < Number(params.get('param_before')))
        .sort((a, b) => b.time - a.time)
        .slice(0, Number(params.get('param_limit'))),
    });
  };
  try {
    for (const clickhouseReadOnly of [false, true]) {
      const store = new MarketStore(
        parseConfig({ ...config, clickhouseReadOnly }),
      );
      const first = await store.bars('tdx', source[0].symbol, 180);
      assert.equal(first.length, 1000);
      assert.equal(first[0].time, start + 600 * 60);
      assert.ok(first.every((bar) => bar.volume === 300));
      const older = await store.bars(
        'tdx',
        source[0].symbol,
        180,
        first[0].time,
      );
      assert.equal(older.length, 200);
      assert.equal(older[0].time, start);
      assert.equal(older.at(-1)!.time + 180, first[0].time);
    }
  } finally {
    globalThis.fetch = original;
  }
});
