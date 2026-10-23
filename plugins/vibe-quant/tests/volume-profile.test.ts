import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPriceProfile,
  PROFILE_RANGES,
  profileRangeStart,
  profileWindow,
  type ProfileTrade,
} from '../volume-profile';
import {
  profilesFromTrades,
  volumeProfileQuery,
  readVolumeProfile,
} from '../server/volume-profile';
import { volumeProfileOverlay } from '../web/indicators/main/volume-profile/overlay';
import { parsePreferences } from '../web/indicators/preferences';
import type { Bar } from '../shared';
import type { TradeDay } from '../server/trades/types';
import { TradeStore } from '../server/trades/store';
import { MarketStore } from '../server/clickhouse';
import { parseConfig } from '../server/config';
import { randomUUID } from 'node:crypto';

const at = (value: string) => Date.parse(`${value}+08:00`) / 1000;
const start = at('2026-10-19T10:00:00');
const query = {
  from: start,
  to: start + 600,
  range: '5m' as const,
  rowSize: 4,
  valueAreaVolume: 70,
};
const trade = (
  price: number,
  size: number,
  side: ProfileTrade['side'] = 'unknown',
): ProfileTrade => ({ price, size, side });
const day: TradeDay = {
  symbol: 'CFFEX.IM2611',
  date: '2026-10-19',
  source: 'tdx-exhq-history',
  sourceSymbol: 'IM2611',
  market: 47,
  fetchedAt: at('2026-10-20T12:00:00'),
  isFinal: true,
  trades: [
    [start, 100, 2, 'buy'],
    [start + 100, 102.5, 3, 'sell'],
    [start + 299, 110, 5, 'unknown'],
    [start + 300, 120, 5, 'buy'],
    [start + 599, 130, 5, 'sell'],
    [start + 600, 140, 5, 'buy'],
  ].map(([time, price, size, side]) => ({
    time: Number(time),
    price: Number(price),
    size: Number(size),
    side: side as ProfileTrade['side'],
    precision: 'second',
    direction: 0,
    openInterestChange: 0,
    nature: 0,
    natureName: '',
  })),
};
const bar = (time: number, duration = 60): Bar => ({
  time,
  duration,
  symbol: 'TEST',
  open: 100,
  high: 140,
  low: 100,
  close: 120,
  volume: 10,
});

test('stock-rl bin edges, volume conservation, direction, POC ties and VA expansion are preserved', () => {
  const profile = buildPriceProfile(
    [
      trade(100, 2, 'buy'),
      trade(102.5, 3, 'sell'),
      trade(105, 5),
      trade(110, 7, 'buy'),
    ],
    4,
    70,
  )!;
  assert.deepEqual(
    profile.rows.map((row) => row.total),
    [2, 3, 5, 7],
  );
  assert.equal(profile.rows[1].sell, 3);
  assert.equal(profile.total, 17);
  assert.equal(profile.poc, 108.75);
  assert.equal(profile.val, 105);
  assert.equal(profile.vah, 110);
  assert.equal(profile.vwap, (100 * 2 + 102.5 * 3 + 105 * 5 + 110 * 7) / 17);
  assert.equal(
    buildPriceProfile([trade(100, 1), trade(102, 1)], 2, 50)!.poc,
    100.5,
  );
  assert.deepEqual(
    buildPriceProfile(
      [trade(100, 2), trade(101.1, 5), trade(103, 2)],
      3,
      70,
    )!.rows.map((r) => r.inValueArea),
    [false, true, true],
  );
  assert.equal(
    buildPriceProfile([trade(10, 5), trade(10, 10), trade(NaN, 10)], 30, 100)!
      .rows.length,
    1,
  );
  assert.equal(buildPriceProfile([], 30, 70), null);
});

test('all reference defaults and ranges persist, invalid stored parameters recover', () => {
  const prefs = parsePreferences(null);
  assert.deepEqual(prefs.volumeProfile, {
    visible: false,
    parameters: {
      rowSize: 30,
      valueAreaVolume: 70,
      range: '1d',
      showCurrent: false,
    },
  });
  for (const range of Object.keys(PROFILE_RANGES)) {
    const stored = {
      volumeProfile: {
        visible: true,
        parameters: { range, rowSize: 60, showCurrent: true },
      },
    };
    assert.deepEqual(parsePreferences(JSON.stringify(stored)).volumeProfile, {
      visible: true,
      parameters: {
        range,
        rowSize: 60,
        showCurrent: true,
        valueAreaVolume: 70,
      },
    });
  }
  assert.equal(
    parsePreferences(
      '{"volumeProfile":{"parameters":{"rowSize":-1,"range":"4d"}}}',
    ).volumeProfile.parameters.rowSize,
    30,
  );
});

test('Beijing fixed anchors, current segment controls, cross-midnight windows and limits', () => {
  for (const span of Object.values(PROFILE_RANGES)) {
    const begin = profileRangeStart(start, span);
    assert.equal(profileRangeStart(begin + span - 0.001, span), begin);
    assert.equal(profileRangeStart(begin + span, span), begin + span);
  }
  assert.deepEqual(profileWindow(start, start + 780, 300, start + 720, false), {
    from: start,
    to: start + 600,
    clipped: false,
  });
  assert.equal(
    profileWindow(start, start + 780, 300, start + 720, true).to,
    start + 720,
  );
  const midnight = at('1970-01-02T00:00:00');
  assert.equal(
    profileWindow(midnight - 60, midnight + 60, 18000, midnight + 3600, false)
      .from,
    at('1970-01-01T20:00:00'),
  );
  const window = profileWindow(
    start - 90 * 86400,
    start + 300,
    300,
    start + 300,
    false,
  );
  assert.equal(window.to - window.from, 240 * 300);
  assert.equal(window.clipped, true);
  assert.ok(volumeProfileQuery.safeParse({ ...query, ...window }).success);
  assert.equal(
    volumeProfileQuery.safeParse({ ...query, from: start + 1 }).success,
    false,
  );
  assert.equal(
    volumeProfileQuery.safeParse({ ...query, to: start + 241 * 300 }).success,
    false,
  );
});

test('profiles use per-print size and source direction, excluding future prints', () => {
  const data = profilesFromTrades([day], query);
  assert.deepEqual(
    data.segments.map((s) => s.profile.total),
    [10, 10],
  );
  assert.deepEqual(
    data.segments.map((s) => s.profile.vwap),
    [105.75, 125],
  );
  assert.equal(
    data.segments[0].profile.rows.reduce((n, r) => n + r.buy, 0),
    2,
  );
  assert.equal(
    data.segments[0].profile.rows.reduce((n, r) => n + r.sell, 0),
    3,
  );
  assert.deepEqual(data.warnings, []);
  assert.equal(
    profilesFromTrades([day], { ...query, to: start + 400 }).segments[1].profile
      .total,
    5,
  );
});

test('missing civil days and stale live prefixes do not generate complete ranges', () => {
  assert.equal(profilesFromTrades([], query).segments.length, 0);
  const prefix = { ...day, isFinal: false, fetchedAt: start + 400 };
  assert.equal(profilesFromTrades([prefix], query).segments.length, 1);
  assert.equal(
    profilesFromTrades([prefix], { ...query, to: start + 400 }).segments.length,
    2,
  );
  const begin = at('1970-01-01T20:00:00'),
    midnight = at('1970-01-02T00:00:00');
  const first = {
    ...day,
    date: '1970-01-01',
    trades: [{ ...day.trades[0], time: midnight - 1, size: 10 }],
  };
  const second = {
    ...day,
    date: '1970-01-02',
    trades: [{ ...day.trades[0], time: midnight, size: 20 }],
  };
  const crossing = {
    ...query,
    from: begin,
    to: begin + 18000,
    range: '5h' as const,
  };
  assert.equal(profilesFromTrades([first], crossing).segments.length, 0);
  assert.equal(
    profilesFromTrades([first, second], crossing).segments[0].profile.total,
    30,
  );
});

test('overlay splits coarse candles, matches stock-rl geometry and warns on incompatible chart periods', () => {
  const data = profilesFromTrades([day], query);
  const params = {
    ...parsePreferences(null).volumeProfile.parameters,
    range: '5m',
  };
  const fine = volumeProfileOverlay(
    [bar(start, 300), bar(start + 300, 300)],
    params,
    300,
    data,
  );
  assert.deepEqual(
    fine.drawings
      .filter((d) => d.id.endsWith(':VWAP'))
      .map((d) => [d.from, d.to]),
    [
      [-0.45, 0.45],
      [0.55, 1.45],
    ],
  );
  const coarse = volumeProfileOverlay([bar(start, 900)], params, 900, data);
  const levels = coarse.drawings.filter((d) => d.id.endsWith(':VWAP'));
  assert.equal(levels.length, 2);
  assert.ok(levels[0].to <= levels[1].from + 1e-10);
  assert.ok(coarse.drawings.some((d) => d.kind === 'box'));
  assert.equal(
    volumeProfileOverlay([bar(start)], params, 86400, data).drawings.length,
    0,
  );
  assert.ok(
    volumeProfileOverlay([bar(start)], params, 2592000, data).warnings!.length,
  );
});

test('stock-rl colors distinguish buy, sell, neutral and outside value area', () => {
  const data = profilesFromTrades([day], query);
  const drawings = volumeProfileOverlay(
    [bar(start, 300), bar(start + 300, 300)],
    { range: '5m' },
    300,
    data,
  ).drawings;
  const colors = new Set(
    drawings.filter((d) => d.kind === 'box').map((d) => d.color),
  );
  assert.ok(colors.has('#e74c3cb3'));
  assert.ok(colors.has('#27ae60b3'));
  assert.ok(colors.has('#95a5a6b3'));
  assert.ok(colors.has('#b6bdc680'));
});

test(
  'real ClickHouse atomically replaces day snapshots, retains identical prints, and respects historical contracts',
  { skip: process.env.QUANT_PROFILE_INTEGRATION !== '1' },
  async () => {
    const database = `profile_test_${randomUUID().replaceAll('-', '')}`;
    const config = parseConfig({
      engine: 'tdx',
      tdxServers: '127.0.0.1:7709',
      clickhouseUrl: 'http://127.0.0.1:18128',
      clickhouseDatabase: database,
      clickhouseUser: 'default',
      clickhousePassword: 'fixture-only',
      beforeOpenMinutes: 5,
      afterCloseMinutes: 10,
      flushSeconds: 2,
      pollSeconds: 5,
      historyBars: 1000,
      maxSubscriptions: 100,
    });
    const market = new MarketStore(config),
      saved = new TradeStore(config);
    await market.request(`CREATE DATABASE ${database}`);
    try {
      await market.initialize();
      await saved.initialize();
      const duplicate = { ...day, trades: [...day.trades, day.trades[0]] };
      await saved.saveDay(duplicate);
      await saved.saveDay(duplicate);
      assert.equal(
        (await saved.readDay(day.symbol, day.date))!.trades.length,
        7,
      );
      const replacement = { ...day, fetchedAt: day.fetchedAt + 1 };
      await saved.saveDay(replacement);
      await saved.saveDay(duplicate); // A slow older request must not win.
      assert.equal(
        (await saved.readDay(day.symbol, day.date))!.trades.length,
        6,
      );
      const reader = {
        readDay: async (symbol: string, date: string) => {
          const result = await saved.readDay(symbol, date);
          if (!result) throw new Error('Missing test day');
          return result;
        },
      };
      for (const engine of ['tqsdk', 'tdx', 'tushare'] as const)
        assert.deepEqual(
          (
            await readVolumeProfile(market, engine, day.symbol, query, reader)
          ).segments.map((s) => s.profile.total),
          [10, 10],
        );
      const quote = {
        symbol: 'KQ.m@CFFEX.IM',
        time: start - 10,
        last: 100,
        preClose: 100,
        open: 100,
        high: 100,
        low: 100,
        volume: 0,
        amount: null,
        openInterest: null,
        bid: null,
        ask: null,
        underlying: day.symbol,
      };
      await market.write('tqsdk', [quote, { ...quote, time: start + 610 }], []);
      assert.equal(
        (await readVolumeProfile(market, 'tqsdk', quote.symbol, query, reader))
          .segments.length,
        2,
      );
      await market.write(
        'tqsdk',
        [{ ...quote, time: start + 200, underlying: 'CFFEX.IM2612' }],
        [],
      );
      assert.equal(
        (await readVolumeProfile(market, 'tqsdk', quote.symbol, query, reader))
          .segments.length,
        0,
      );
      for (const table of ['bars', 'order_books', 'ticks']) {
        const [row] = await market.rows<{ count: number }>(
          `SELECT count() AS count FROM ${market.table(table)}`,
        );
        assert.equal(
          Number(row.count),
          0,
          `trade ingestion must not write ${table}`,
        );
      }
    } finally {
      await market.request(`DROP DATABASE ${database}`);
    }
  },
);
