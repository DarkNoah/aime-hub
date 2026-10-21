import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import { MONTH_DURATION, type Bar } from '../shared.js';
import {
  centeredRange,
  jumpTimestamp,
  mergeBars,
} from '../web/chart-navigation.js';

const start = Date.parse('2026-01-01T09:30:00+08:00') / 1000;
const makeBar = (time: number, duration = 60): Bar => ({
  symbol: 'SSE.600000',
  duration,
  time,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 100,
});
const config = parseConfig({
  engine: 'tdx',
  clickhouseUrl: 'http://127.0.0.1:8123',
  clickhouseDatabase: 'vibe_quant',
  clickhouseUser: 'fixture',
  clickhousePassword: 'fixture',
  tdxServers: '127.0.0.1:7709',
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 2,
  pollSeconds: 5,
  historyBars: 1000,
  maxSubscriptions: 100,
});

async function withHistory(
  source: Bar[],
  run: (store: MarketStore) => Promise<void>,
  readOnly = false,
) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const params = new URL(String(input)).searchParams;
    const forward = params.has('param_after');
    const rows =
      params.get('param_engine') === 'tdx'
        ? source.filter(
            (bar) =>
              bar.symbol === params.get('param_symbol') &&
              bar.duration === Number(params.get('param_duration')) &&
              bar.time < Number(params.get('param_before')) &&
              (!forward || bar.time > Number(params.get('param_after'))),
          )
        : [];
    rows.sort((a, b) => (forward ? a.time - b.time : b.time - a.time));
    return Response.json({
      data: rows.slice(0, Number(params.get('param_limit'))),
    });
  };
  try {
    await run(new MarketStore({ ...config, clickhouseReadOnly: readOnly }));
  } finally {
    globalThis.fetch = original;
  }
}

test('date jump loads exactly 100 neighbors on each side and centers the containing candle', async () => {
  const bars = Array.from({ length: 700 }, (_, i) => makeBar(start + i * 60));
  await withHistory(bars, async (store) => {
    for (const offset of [0, 45]) {
      const result = await store.barsAround(
        'tdx',
        bars[0].symbol,
        60,
        bars[350].time + offset,
      );
      assert.deepEqual(result.bars, bars.slice(250, 451));
      assert.equal(result.targetTime, bars[350].time);
      assert.deepEqual(centeredRange(result.bars, result.targetTime!), {
        from: -0.5,
        to: 200.5,
      });
    }
    const older = await store.bars('tdx', bars[0].symbol, 60, {
      before: bars[250].time,
      limit: 200,
    });
    const newer = await store.bars('tdx', bars[0].symbol, 60, {
      after: bars[450].time,
      limit: 200,
    });
    assert.deepEqual(older, bars.slice(50, 250));
    assert.deepEqual(newer, bars.slice(451, 651));
    assert.deepEqual(
      await store.barsAround('tqsdk', bars[0].symbol, 60, start),
      { bars: [], targetTime: null },
    );
  });
});

test('gaps and history endpoints choose the nearest available candle without losing centering', async () => {
  const bars = [makeBar(start), makeBar(start + 3 * 86400)];
  await withHistory(bars, async (store) => {
    for (const [target, expected] of [
      [start - 86400, 0],
      [start + 3600, 0],
      [start + 2 * 86400, 1],
      [start + 4 * 86400, 1],
    ]) {
      const result = await store.barsAround('tdx', bars[0].symbol, 60, target);
      assert.equal(result.targetTime, bars[expected].time);
      const range = centeredRange(result.bars, result.targetTime!)!;
      assert.equal((range.from + range.to) / 2, expected);
    }
  });
});

test('derived forward pages retain full groups, have no overlap, and include live corrections', async () => {
  const bars = Array.from({ length: 3600 }, (_, i) => makeBar(start + i * 60));
  for (const readOnly of [false, true]) {
    await withHistory(
      bars,
      async (store) => {
        if (readOnly)
          await store.write(
            'tdx',
            [],
            [{ ...bars[301], close: 15, high: 15, volume: 200 }],
          );
        const window = await store.barsAround(
          'tdx',
          bars[0].symbol,
          180,
          start + 300 * 60 + 90,
        );
        assert.equal(window.bars.length, 201);
        assert.equal(window.targetTime, start + 300 * 60);
        assert.equal(window.bars[100].volume, readOnly ? 400 : 300);
        assert.equal(window.bars[100].high, readOnly ? 15 : 12);
        const next = await store.bars('tdx', bars[0].symbol, 180, {
          after: window.bars.at(-1)!.time,
          limit: 200,
        });
        assert.equal(next.length, 200);
        assert.equal(next[0].time, window.bars.at(-1)!.time + 180);
        assert.ok(next.every((bar) => bar.volume === 300));
        const previous = await store.bars('tdx', bars[0].symbol, 180, {
          before: next[0].time,
          limit: 200,
        });
        assert.equal(previous.at(-1)!.time, window.bars.at(-1)!.time);
      },
      readOnly,
    );
  }
});

test('monthly forward pages start at the next calendar month and aggregate complete months', async () => {
  const bars = Array.from({ length: 500 }, (_, i) =>
    makeBar(Date.parse('2024-01-01T00:00:00+08:00') / 1000 + i * 86400, 86400),
  );
  await withHistory(bars, async (store) => {
    const january = bars[0].time;
    const page = await store.bars('tdx', bars[0].symbol, MONTH_DURATION, {
      after: january,
      limit: 2,
    });
    assert.deepEqual(
      page.map((bar) => [bar.time, bar.volume]),
      [
        [Date.parse('2024-02-01T00:00:00+08:00') / 1000, 2900],
        [Date.parse('2024-03-01T00:00:00+08:00') / 1000, 3100],
      ],
    );
    const window = await store.barsAround(
      'tdx',
      bars[0].symbol,
      MONTH_DURATION,
      january + 15 * 86400,
    );
    assert.equal(window.targetTime, january);
    assert.equal(window.bars[0].volume, 3100);
  });
});

test('read-only forward paging merges the nearest live data and stays scoped', async () => {
  const bars = Array.from({ length: 5 }, (_, i) => makeBar(start + i * 60));
  await withHistory(
    bars,
    async (store) => {
      const live = [{ ...bars[2], close: 13 }, makeBar(start + 5 * 60)];
      await store.write('tdx', [], live);
      assert.deepEqual(
        await store.bars('tdx', bars[0].symbol, 60, {
          after: bars[1].time,
          limit: 2,
        }),
        [live[0], bars[3]],
      );
      assert.deepEqual(
        await store.bars('tdx', bars[0].symbol, 60, {
          after: bars[3].time,
          limit: 2,
        }),
        [bars[4], live[1]],
      );
      assert.deepEqual(
        await store.bars('tqsdk', bars[0].symbol, 60, { after: bars[1].time }),
        [],
      );
    },
    true,
  );
});

test('navigation uses UTC+8 regardless of system timezone and merges overlapping pages chronologically', () => {
  assert.equal(jumpTimestamp('2026-01-01', '09:31', 60), start);
  assert.equal(jumpTimestamp('2026-01-01', '', 60), start - 9.5 * 3600);
  for (const [date, time] of [
    ['2026-02-30', ''],
    ['', ''],
    ['2026-01-01', '25:00'],
  ])
    assert.equal(jumpTimestamp(date, time, 60), null);
  const first = makeBar(start),
    second = makeBar(start + 60),
    updated = { ...second, close: 15 };
  assert.deepEqual(mergeBars([second], [updated, first]), [first, updated]);
});

test('date jumps translate close labels to source starts without shifting date-only or calendar queries', () => {
  for (const [duration, label] of [
    [180, '09:33'],
    [300, '09:35'],
    [900, '09:45'],
    [1800, '10:00'],
    [3600, '10:30'],
  ] as const) {
    assert.equal(jumpTimestamp('2026-01-01', label, duration), start);
    assert.equal(jumpTimestamp('2026-01-01', '', duration), start - 9.5 * 3600);
  }
  assert.equal(
    jumpTimestamp('2026-01-02', '00:00', 60),
    Date.parse('2026-01-01T23:59:00+08:00') / 1000,
  );
  for (const duration of [86400, MONTH_DURATION])
    assert.equal(jumpTimestamp('2026-01-01', '09:30', duration), start);
});
