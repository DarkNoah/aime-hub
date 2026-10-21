import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MONTH_DURATION, type Bar, type Tick } from '../shared.js';
import { rebuildTickBars, mergeTickBars } from '../server/tick-bars.js';
import { MarketStore } from '../server/clickhouse.js';
import {
  ClickHouseClient,
  ClickHouseError,
} from '../server/clickhouse-client.js';
import { parseConfig } from '../server/config.js';

const at = (text: string) => Date.parse(`${text}+08:00`) / 1000;
const start = at('2026-10-19T09:30:00');
const prices = (bar: Bar) => [bar.open, bar.high, bar.low, bar.close];
const base: Bar = {
  symbol: 'CFFEX.IM2611',
  time: start,
  duration: 60,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 5,
  amount: null,
};
const config = parseConfig({
  engine: 'tdx',
  tdxServers: '127.0.0.1:7709',
  clickhouseUrl: 'http://127.0.0.1:18126',
  clickhouseDatabase: 'default',
  clickhouseUser: 'default',
  clickhousePassword: 'fixture-only',
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 2,
  pollSeconds: 5,
  historyBars: 1000,
  maxSubscriptions: 100,
});

test('only validated, matching-volume turnover fills absent values; source amounts and unknowns survive', () => {
  const bars = [
    base,
    { ...base, time: start + 60, amount: 123 },
    { ...base, time: start + 120, volume: 0 },
  ];
  const amounts = [
    { time: start, volume: 5, amount: 506, ohlc: [] },
    { time: start + 60, volume: 5, amount: 999, ohlc: [] },
    { time: start + 120, volume: 0, amount: 0, ohlc: [] },
  ];
  assert.deepEqual(
    mergeTickBars(bars, amounts).map((b) => b.amount),
    [506, 123, 0],
  );
  for (const row of [
    { ...amounts[0], volume: 6 },
    { ...amounts[0], amount: null },
    { ...amounts[0], amount: NaN },
    { ...amounts[0], amount: -1 },
  ]) {
    assert.equal(mergeTickBars([base], [row])[0].amount, null);
  }
  assert.equal(base.amount, null);
});

test('OHLC is replaced as a group independently of turnover, only for valid matching-volume trades', () => {
  const row = { time: start, volume: 5, amount: null, ohlc: [11, 13, 10, 12] };
  const rebuilt = { ...base, open: 11, high: 13, low: 10, close: 12 };
  assert.deepEqual(mergeTickBars([base], [row]), [rebuilt]);
  assert.deepEqual(
    mergeTickBars([{ ...base, amount: 123 }], [{ ...row, amount: 456 }]),
    [{ ...rebuilt, amount: 123 }],
  );
  for (const invalid of [
    { ...row, volume: 6 },
    { ...row, ohlc: [] },
    { ...row, ohlc: [11, 13, 10] },
    { ...row, ohlc: [null, 13, 10, 12] },
    { ...row, ohlc: [0, 13, 10, 12] },
    { ...row, ohlc: [11, NaN, 10, 12] },
    { ...row, ohlc: [11, 10, 10, 12] },
    { ...row, ohlc: [11, 13, 12, 12] },
  ])
    assert.equal(mergeTickBars([base], [invalid])[0], base);
  assert.deepEqual(mergeTickBars([base], [{ ...row, ohlc: [], amount: 506 }]), [
    { ...base, amount: 506 },
  ]);
  const empty = { ...base, volume: 0 };
  assert.equal(mergeTickBars([empty], [{ ...row, volume: 0 }])[0], empty);
  assert.equal(base.open, 10, 'raw bars are never mutated');
});

test('optional Tick access degrades only known missing-table/access/limit errors and skips other sources', async () => {
  class Client extends ClickHouseClient {
    calls = 0;
    code = 60;
    override async rows<T>(): Promise<T[]> {
      this.calls++;
      throw new ClickHouseError(500, this.code);
    }
  }
  const client = new Client(config);
  for (const code of [60, 497, 158, 159]) {
    client.code = code;
    assert.deepEqual(
      await rebuildTickBars(client, 'tqsdk', base.symbol, 60, [base]),
      [base],
    );
  }
  const calls = client.calls;
  for (const [engine, symbol, bars] of [
    ['tdx', base.symbol, [base]],
    ['tqsdk', 'KQ.i@CFFEX.IM', [base]],
    ['tqsdk', base.symbol, []],
  ] as const) {
    await rebuildTickBars(client, engine, symbol, 60, [...bars]);
  }
  assert.equal(client.calls, calls);
  assert.deepEqual(
    await rebuildTickBars(client, 'tqsdk', 'KQ.m@CFFEX.IM', 60, [base]),
    [base],
    'unreadable historical mappings preserve continuous bars',
  );
  await rebuildTickBars(client, 'tqsdk', base.symbol, 60, [
    { ...base, amount: 0 },
  ]);
  assert.equal(
    client.calls,
    calls + 2,
    'native turnover must not skip OHLC reconstruction',
  );
  client.code = 47;
  await assert.rejects(
    rebuildTickBars(client, 'tqsdk', base.symbol, 60, [base]),
    { code: 47 },
  );
});

function tick(
  symbol: string,
  id: number,
  seconds: number,
  volume: number | null,
  amount: number | null,
  day = '2026-10-19',
  nano = 0n,
): Tick {
  return {
    symbol,
    tickId: String(id),
    timeNs: String(BigInt(seconds) * 1000000000n + nano),
    tradingDay: day,
    receivedAt: seconds,
    last: 10,
    volume,
    amount,
    openInterest: null,
    bid: null,
    bidVolume: null,
    ask: null,
    askVolume: null,
    priceTick: 0.2,
    volumeMultiple: 200,
    volumeUnit: 'source',
  };
}

test(
  'real ClickHouse Tick bars: OHLC, turnover, boundaries, gaps/backfills, corrections, readonly, trading days and months',
  { skip: process.env.QUANT_AMOUNT_INTEGRATION !== '1' },
  async () => {
    const db = `tick_amount_${randomUUID().replaceAll('-', '')}`;
    const store = new MarketStore({ ...config, clickhouseDatabase: db });
    const user = `${db}_reader`;
    await store.request(`CREATE DATABASE ${db}`);
    try {
      await store.initialize();
      const ticks = [
        tick(base.symbol, 10, start - 1, 10, 1000, undefined, 999999999n),
        tick(base.symbol, 11, start, 12, 1201),
        tick(base.symbol, 12, start + 59, 15, 1506, undefined, 999999999n),
        tick(base.symbol, 13, start + 60, 18, 1809),
        tick(base.symbol, 14, start + 90, 23, 2319),
        tick(base.symbol, 15, start + 120, 23, 2319),
        tick(base.symbol, 16, start + 150, 23, 2319),
        tick(base.symbol, 17, start + 180, 25, 2520),
      ];
      const bars = [
        base,
        { ...base, time: start + 60, volume: 8 },
        { ...base, time: start + 120, volume: 0 },
        { ...base, time: start + 180, volume: 2 },
      ];
      await store.write(
        'tqsdk',
        [],
        bars,
        [],
        undefined,
        ticks.filter((t) => t.tickId !== '12'),
      );
      const read = () => store.bars('tqsdk', base.symbol, 60);
      assert.deepEqual(
        (await read()).map((b) => b.amount),
        [null, null, 0, null],
        'missing boundary/inside ticks and unfinished bars remain unknown',
      );
      await store.write('tqsdk', [], [], [], undefined, [ticks[2]]);
      assert.deepEqual(
        (await read()).map((b) => b.amount),
        [506, 813, 0, null],
      );
      await store.write('tqsdk', [], [], [], undefined, ticks);
      assert.deepEqual(
        (await read()).map((b) => b.amount),
        [506, 813, 0, null],
        'replay cannot double count',
      );
      assert.equal(
        (await store.bars('tqsdk', base.symbol, 180))[0].amount,
        1319,
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', base.symbol, 180))[0]),
        [10, 10, 10, 10],
      );
      assert.deepEqual(
        prices((await read())[2]),
        prices(base),
        'zero-volume bars keep source prices',
      );
      assert.equal(
        (await store.barsAround('tqsdk', base.symbol, 60, start + 60)).bars[1]
          .amount,
        813,
      );
      assert.equal(
        (
          await store.bars('tqsdk', base.symbol, 60, { after: start, limit: 1 })
        )[0].amount,
        813,
      );
      assert.equal(
        (
          await store.bars('tqsdk', base.symbol, 60, {
            before: start + 60,
            limit: 1,
          })
        )[0].amount,
        506,
      );
      await store.write('tqsdk', [], [{ ...base, volume: 99 }]);
      assert.equal(
        (await read())[0].amount,
        null,
        'reference K-line volume must reconcile',
      );
      await store.write('tqsdk', [], [base]);
      for (const amount of [null, -1, 999, NaN]) {
        await store.write('tqsdk', [], [], [], undefined, [
          { ...ticks[2], amount },
        ]);
        assert.equal(
          (await read())[0].amount,
          null,
          `invalid/regressing cumulative amount ${amount}`,
        );
      }
      await store.write('tqsdk', [], [], [], undefined, [ticks[2]]);
      assert.equal((await read())[0].amount, 506);

      for (const volume of [null, -1, 11, NaN]) {
        await store.write('tqsdk', [], [], [], undefined, [
          { ...ticks[2], volume },
        ]);
        assert.equal((await read())[0].amount, null);
      }
      await store.write('tqsdk', [], [], [], undefined, [ticks[2]]);
      for (const duration of [300, 900, 1800, 3600]) {
        const symbol = `TEST.PERIOD${duration}`;
        const time = Math.floor(start / duration) * duration;
        await store.write(
          'tqsdk',
          [],
          [{ ...base, symbol, duration, time }],
          [],
          undefined,
          [
            tick(symbol, 1, time - 1, 10, 100),
            tick(symbol, 2, time, 12, 120),
            tick(symbol, 3, time + duration - 1, 15, 151),
            tick(symbol, 4, time + duration, 16, 161),
          ],
        );
        assert.equal(
          (await store.bars('tqsdk', symbol, duration))[0].amount,
          51,
        );
        assert.deepEqual(
          prices((await store.bars('tqsdk', symbol, duration))[0]),
          [10, 10, 10, 10],
        );
      }

      // IM2612 13:08 starts at the first in-period trade, not the preceding close.
      // Quote-only and out-of-period prices must not enter OHLC.
      const priceSymbol = 'TEST.OHLC';
      const priceStart = at('2026-10-21T13:07:00');
      const original = {
        ...base,
        symbol: priceSymbol,
        time: priceStart,
        open: 6719,
        high: 6720,
        low: 6707.2,
        close: 6708.6,
        volume: 402,
      };
      const priceTicks = [
        tick(priceSymbol, 100, priceStart - 1, 103840, 100000, '2026-10-21'),
        tick(priceSymbol, 101, priceStart, 103840, 100000, '2026-10-21'),
        tick(
          priceSymbol,
          102,
          priceStart,
          103842,
          100020,
          '2026-10-21',
          300000000n,
        ),
        tick(
          priceSymbol,
          103,
          priceStart,
          103842,
          100020,
          '2026-10-21',
          800000000n,
        ),
        tick(priceSymbol, 104, priceStart + 2, 103940, 101000, '2026-10-21'),
        tick(
          priceSymbol,
          105,
          priceStart + 59,
          104242,
          104020,
          '2026-10-21',
          800000000n,
        ),
        tick(
          priceSymbol,
          106,
          priceStart + 60,
          104244,
          104040,
          '2026-10-21',
          300000000n,
        ),
      ].map((item, i) => ({
        ...item,
        last: [9000, 6719, 6720, 99999, 6707.2, 6708.6, 1][i],
      }));
      const readPrice = async () =>
        (await store.bars('tqsdk', priceSymbol, 60))[0];
      const expectedPrices = [6720, 6720, 6707.2, 6708.6];
      await store.write(
        'tqsdk',
        [],
        [original],
        [],
        undefined,
        priceTicks.filter((t) => t.tickId !== '103'),
      );
      assert.deepEqual(
        prices(await readPrice()),
        prices(original),
        'even a quote-only sequence gap rejects reconstruction',
      );
      await store.write('tqsdk', [], [], [], undefined, [priceTicks[3]]);
      assert.deepEqual(prices(await readPrice()), expectedPrices);
      assert.equal((await readPrice()).amount, 4020);
      assert.deepEqual(
        prices(
          (await store.barsAround('tqsdk', priceSymbol, 60, priceStart))
            .bars[0],
        ),
        expectedPrices,
      );
      assert.deepEqual(
        prices(
          (
            await store.bars('tqsdk', priceSymbol, 60, {
              after: priceStart - 1,
              limit: 1,
            })
          )[0],
        ),
        expectedPrices,
      );
      assert.deepEqual(
        prices(
          (
            await store.bars('tqsdk', priceSymbol, 60, {
              before: priceStart + 60,
              limit: 1,
            })
          )[0],
        ),
        expectedPrices,
      );
      await store.write('tqsdk', [], [{ ...original, amount: 123 }]);
      assert.deepEqual(prices(await readPrice()), expectedPrices);
      assert.equal(
        (await readPrice()).amount,
        123,
        'native amount survives alongside rebuilt prices',
      );
      await store.write('tqsdk', [], [original]);
      await store.write('tqsdk', [], [], [], undefined, [
        { ...priceTicks[4], amount: null },
      ]);
      assert.deepEqual(
        prices(await readPrice()),
        expectedPrices,
        'missing turnover does not prevent price reconstruction',
      );
      assert.equal((await readPrice()).amount, null);
      await store.write('tqsdk', [], [], [], undefined, [priceTicks[4]]);
      for (const last of [null, 0, -1, NaN]) {
        await store.write('tqsdk', [], [], [], undefined, [
          { ...priceTicks[2], last },
        ]);
        assert.deepEqual(
          prices(await readPrice()),
          prices(original),
          'invalid traded price rejects the whole OHLC',
        );
        assert.equal(
          (await readPrice()).amount,
          4020,
          'valid turnover remains available',
        );
      }
      await store.write('tqsdk', [], [], [], undefined, [
        priceTicks[2],
        { ...priceTicks[3], last: null },
      ]);
      assert.deepEqual(
        prices(await readPrice()),
        expectedPrices,
        'missing price on a quote-only tick is irrelevant',
      );
      await store.write('tqsdk', [], [{ ...original, volume: 403 }]);
      assert.deepEqual(
        prices(await readPrice()),
        prices(original),
        'volume mismatch rejects reconstruction',
      );
      assert.equal((await readPrice()).amount, null);
      await store.write('tqsdk', [], [original]);
      assert.deepEqual(prices(await readPrice()), expectedPrices);

      const unfinishedSymbol = 'TEST.UNFINISHED';
      await store.write(
        'tqsdk',
        [],
        [{ ...original, symbol: unfinishedSymbol }],
        [],
        undefined,
        priceTicks
          .slice(0, -1)
          .map((t) => ({ ...t, symbol: unfinishedSymbol })),
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', unfinishedSymbol, 60))[0]),
        prices(original),
      );
      await store.write('tqsdk', [], [], [], undefined, [
        { ...priceTicks.at(-1)!, symbol: unfinishedSymbol },
      ]);
      assert.deepEqual(
        prices((await store.bars('tqsdk', unfinishedSymbol, 60))[0]),
        expectedPrices,
      );

      // Equal timestamps are ordered by the exact UInt64 sequence, not milliseconds.
      const same = 'TEST.SAME';
      await store.write(
        'tqsdk',
        [],
        [{ ...base, symbol: same }],
        [],
        undefined,
        [
          tick(same, 100, start - 1, 0, 0),
          { ...tick(same, 101, start, 2, 20), last: 11 },
          { ...tick(same, 102, start, 5, 51), last: 9 },
          tick(same, 103, start + 60, 6, 61),
        ],
      );
      assert.equal((await store.bars('tqsdk', same, 60))[0].amount, 51);
      assert.deepEqual(
        prices((await store.bars('tqsdk', same, 60))[0]),
        [11, 11, 9, 9],
      );
      const partial = 'TEST.PARTIAL';
      await store.write(
        'tqsdk',
        [],
        [{ ...base, symbol: partial }],
        [],
        undefined,
        [
          tick(partial, 101, start, 2, 20),
          tick(partial, 102, start + 30, 5, 51),
          tick(partial, 103, start + 60, 6, 61),
        ],
      );
      assert.equal(
        (await store.bars('tqsdk', partial, 60))[0].amount,
        null,
        'a positive first snapshot is not a zero baseline',
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', partial, 60))[0]),
        prices(base),
      );
      await store.write('tdx', [], [], [], undefined, [
        tick(partial, 100, start - 1, 0, 0),
      ]);
      assert.equal(
        (await store.bars('tqsdk', partial, 60))[0].amount,
        null,
        'different engines cannot supply the missing baseline',
      );

      await store.request(`CREATE USER ${user} IDENTIFIED BY 'fixture-only'`);
      await store.request(`GRANT SELECT ON ${db}.bars TO ${user}`);
      const reader = new MarketStore({
        ...config,
        clickhouseDatabase: db,
        clickhouseUser: user,
        clickhouseReadOnly: true,
      });
      assert.equal(
        (await reader.bars('tqsdk', base.symbol, 60))[0].amount,
        null,
      );
      await store.request(`GRANT SELECT ON ${db}.ticks TO ${user}`);
      assert.deepEqual(
        prices((await reader.bars('tqsdk', priceSymbol, 60))[0]),
        expectedPrices,
      );
      assert.equal(
        (await reader.bars('tqsdk', base.symbol, 60))[0].amount,
        506,
      );
      await reader.write('tqsdk', [], [{ ...base, volume: 50 }]);
      assert.equal(
        (await reader.bars('tqsdk', base.symbol, 60))[0].amount,
        null,
        'readonly live bars are reconciled after merging',
      );
      assert.deepEqual(
        prices((await reader.bars('tqsdk', base.symbol, 60))[0]),
        prices(base),
      );

      const daily = 'SHFE.TEST';
      const monday = at('2026-10-19T00:00:00');
      const dailyBar = {
        ...base,
        symbol: daily,
        duration: 86400,
        time: monday,
        volume: 9,
      };
      const night = at('2026-10-16T21:00:00');
      const dailyTicks = [
        tick(daily, 20, at('2026-10-16T15:00:00'), 50, 500, '2026-10-16'),
        tick(daily, 21, night, 2, 21),
        tick(daily, 22, at('2026-10-17T01:00:00'), 5, 53),
        tick(daily, 23, at('2026-10-19T14:59:59'), 9, 96),
        tick(daily, 24, at('2026-10-19T21:00:00'), 1, 12, '2026-10-20'),
      ].map((item, i) => ({ ...item, last: [100, 11, 9, 12, 1000][i] }));
      await store.write('tqsdk', [], [dailyBar], [], undefined, dailyTicks);
      assert.equal(
        (await store.bars('tqsdk', daily, 86400))[0].amount,
        96,
        'Friday night and Monday day are one trading day; reset starts from zero',
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', daily, 86400))[0]),
        [11, 12, 9, 12],
      );
      const month = at('2026-10-01T00:00:00');
      assert.equal(
        (await store.bars('tqsdk', daily, MONTH_DURATION))[0].amount,
        null,
        'partial month does not inherit a complete daily amount',
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', daily, MONTH_DURATION))[0]),
        prices(base),
      );
      const monthly = 'TEST.MONTH';
      await store.write(
        'tqsdk',
        [],
        [
          { ...dailyBar, symbol: monthly, time: month, volume: 5 },
          { ...dailyBar, symbol: monthly, time: monday, volume: 4 },
        ],
        [],
        undefined,
        [
          tick(monthly, 50, at('2026-09-30T15:00:00'), 10, 100, '2026-09-30'),
          tick(monthly, 51, at('2026-09-30T21:00:00'), 2, 21, '2026-10-01'),
          tick(monthly, 52, at('2026-10-01T15:00:00'), 5, 53, '2026-10-01'),
          tick(monthly, 53, night, 1, 11),
          tick(monthly, 54, at('2026-10-19T15:00:00'), 4, 46),
          tick(monthly, 55, at('2026-10-30T21:00:00'), 1, 12, '2026-11-02'),
        ].map((item, i) => ({ ...item, last: [1000, 11, 12, 8, 9, 100][i] })),
      );
      assert.equal(
        (await store.bars('tqsdk', monthly, MONTH_DURATION))[0].amount,
        99,
        'month groups by trading day including nights crossing the month',
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', monthly, MONTH_DURATION))[0]),
        [11, 12, 8, 9],
      );
      await store.request(`DROP TABLE ${db}.ticks`);
      assert.equal(
        (await store.bars('tqsdk', base.symbol, 60))[0].amount,
        null,
        'legacy databases keep serving bars',
      );
    } finally {
      await store.request(`DROP DATABASE ${db}`);
      await store.request(`DROP USER IF EXISTS ${user}`);
    }
  },
);
