import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MONTH_DURATION, type Bar, type Quote, type Tick } from '../shared.js';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';

const at = (date: string) => Date.parse(`${date}+08:00`) / 1000;
const start = at('2026-10-19T09:30:00');
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
const candle = (
  symbol: string,
  time = start,
  duration = 60,
  volume = 5,
): Bar => ({
  symbol,
  time,
  duration,
  volume,
  open: 1,
  high: 3,
  low: 1,
  close: 2,
  amount: null,
});
const quote = (symbol: string, underlying: string, time: number): Quote => ({
  symbol,
  underlying,
  time,
  last: null,
  preClose: null,
  open: null,
  high: null,
  low: null,
  volume: null,
  amount: null,
  openInterest: null,
  bid: null,
  ask: null,
});
const tick = (
  symbol: string,
  id: number,
  time: number,
  volume: number,
  last: number,
  tradingDay = '2026-10-19',
): Tick => ({
  symbol,
  tickId: String(id),
  timeNs: String(BigInt(time) * 1000000000n),
  tradingDay,
  receivedAt: time,
  last,
  volume,
  amount: volume * 100,
  openInterest: null,
  bid: null,
  bidVolume: null,
  ask: null,
  askVolume: null,
  priceTick: 0.2,
  volumeMultiple: 200,
  volumeUnit: 'source',
});
const prices = (bar: Bar) => [bar.open, bar.high, bar.low, bar.close];

test(
  'continuous Tick reconstruction uses historical runs, never the latest contract or a mixed roll',
  { skip: process.env.QUANT_AMOUNT_INTEGRATION !== '1' },
  async () => {
    const database = `continuous_${randomUUID().replaceAll('-', '')}`;
    const store = new MarketStore({ ...config, clickhouseDatabase: database });
    await store.request(`CREATE DATABASE ${database}`);
    try {
      await store.initialize();
      const main = 'KQ.m@TEST.F';
      const oldContract = 'TEST.F2611';
      const newContract = 'TEST.F2612';
      const bars = Array.from({ length: 5 }, (_, i) =>
        candle(main, start + i * 60),
      );
      const ticks: Tick[] = [];
      for (const [contract, price] of [
        [oldContract, 100],
        [newContract, 200],
      ] as const) {
        ticks.push(tick(contract, 100, start - 1, 10, 999));
        for (let i = 0; i < 5; i++) {
          ticks.push(
            tick(contract, 101 + i * 2, start + i * 60, 12 + i * 5, price + 1),
          );
          ticks.push(
            tick(
              contract,
              102 + i * 2,
              start + i * 60 + 59,
              15 + i * 5,
              price + 2,
            ),
          );
        }
        ticks.push(tick(contract, 111, start + 300, 36, 999));
      }
      await store.write(
        'tqsdk',
        [
          quote(main, oldContract, start - 1),
          quote(main, oldContract, start + 60),
          quote(main, newContract, start + 90),
          quote(main, newContract, start + 180),
          quote(main, oldContract, start + 210),
          quote(main, oldContract, start + 300),
          quote(main, newContract, start + 360),
        ],
        bars,
        [],
        undefined,
        ticks,
      );
      const result = await store.bars('tqsdk', main, 60);
      assert.deepEqual(result.map(prices), [
        [101, 102, 101, 102],
        prices(bars[1]),
        [201, 202, 201, 202],
        prices(bars[3]),
        [101, 102, 101, 102],
      ]);
      assert.deepEqual(
        result.map((b) => b.amount),
        [500, null, 500, null, 500],
      );
      assert.ok(result.every((b) => b.symbol === main));
      assert.deepEqual(
        (
          await store.bars('tqsdk', main, 60, { before: start + 60, limit: 1 })
        )[0],
        result[0],
      );
      assert.deepEqual(
        (
          await store.bars('tqsdk', main, 60, { after: start + 60, limit: 1 })
        )[0],
        result[2],
      );
      assert.deepEqual(
        (await store.barsAround('tqsdk', main, 60, start + 120)).bars,
        result,
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', main, 180))[0]),
        prices(bars[0]),
        'a roll inside a derived 3m bar is not spliced',
      );

      // Unknown mapping at the beginning, empty mappings, volume mismatches and
      // non-main weighted indices cannot borrow an actual contract's prices.
      const other = 'KQ.m@TEST.G';
      const actual = 'TEST.G2611';
      await store.write(
        'tqsdk',
        [quote(other, actual, start + 1), quote(other, actual, start + 60)],
        [candle(other)],
        [],
        undefined,
        ticks
          .filter((t) => t.symbol === oldContract)
          .map((t) => ({ ...t, symbol: actual })),
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', other, 60))[0]),
        prices(candle(other)),
      );
      await store.write(
        'tqsdk',
        [quote(other, actual, start - 1), quote(other, '', start + 30)],
        [],
      );
      assert.equal((await store.bars('tqsdk', other, 60))[0].amount, null);
      // Corrected historical quotes are read through FINAL on each request.
      await store.write('tqsdk', [quote(other, actual, start + 30)], []);
      assert.equal((await store.bars('tqsdk', other, 60))[0].amount, 500);
      await store.write('tqsdk', [], [candle(other, start, 60, 6)]);
      assert.deepEqual(
        prices((await store.bars('tqsdk', other, 60))[0]),
        prices(candle(other)),
      );
      const index = 'KQ.i@TEST.F';
      await store.write(
        'tqsdk',
        [
          quote(index, oldContract, start - 1),
          quote(index, oldContract, start + 60),
        ],
        [candle(index)],
      );
      assert.equal((await store.bars('tqsdk', index, 60))[0].amount, null);

      // A dated option uses its own Tick series with exactly the same checks.
      const option = 'CFFEX.MO2611-C-7700';
      await store.write(
        'tqsdk',
        [],
        [candle(option)],
        [],
        undefined,
        ticks
          .filter((t) => t.symbol === oldContract)
          .map((t) => ({ ...t, symbol: option })),
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', option, 60))[0]),
        [101, 102, 101, 102],
      );

      // Monday's trading day starts on Friday night. Discovery at Monday's
      // calendar label must expand to the actual first Tick before accepting it.
      const nightMain = 'KQ.m@SHFE.au';
      const gold = 'SHFE.au2611';
      const monday = at('2026-10-19T00:00:00');
      const night = at('2026-10-16T21:00:00');
      const close = at('2026-10-19T14:59:59');
      const nightQuotes = [
        quote(nightMain, gold, night - 1),
        quote(nightMain, gold, monday - 1),
        quote(nightMain, gold, close + 1),
      ];
      await store.write(
        'tqsdk',
        nightQuotes,
        [candle(nightMain, monday, 86400, 9)],
        [],
        undefined,
        [
          tick(gold, 1, night - 60, 50, 999, '2026-10-16'),
          tick(gold, 2, night, 2, 11),
          tick(gold, 3, close, 9, 12),
          tick(gold, 4, at('2026-10-19T21:00:00'), 1, 999, '2026-10-20'),
        ],
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', nightMain, 86400))[0]),
        [11, 12, 11, 12],
      );
      await store.write(
        'tqsdk',
        [quote(nightMain, 'SHFE.au2610', night - 1)],
        [],
      );
      assert.equal(
        (await store.bars('tqsdk', nightMain, 86400))[0].amount,
        null,
        'a night-time mapping change rejects the whole daily bar',
      );

      const monthMain = 'KQ.m@TEST.M';
      const monthContract = 'TEST.M2611';
      const month = at('2026-10-01T00:00:00');
      const monthNight = at('2026-09-30T21:00:00');
      const monthEnd = at('2026-10-19T15:00:00');
      await store.write(
        'tqsdk',
        [
          quote(monthMain, monthContract, monthNight - 1),
          quote(monthMain, monthContract, monthEnd + 1),
        ],
        [
          candle(monthMain, month, 86400, 2),
          candle(monthMain, monday, 86400, 3),
        ],
        [],
        undefined,
        [
          tick(monthContract, 1, monthNight - 60, 50, 999, '2026-09-30'),
          tick(monthContract, 2, monthNight, 2, 11, '2026-10-01'),
          tick(monthContract, 3, monthEnd, 3, 12, '2026-10-19'),
          tick(
            monthContract,
            4,
            at('2026-10-30T21:00:00'),
            1,
            999,
            '2026-11-02',
          ),
        ],
      );
      assert.deepEqual(
        prices((await store.bars('tqsdk', monthMain, MONTH_DURATION))[0]),
        [11, 12, 11, 12],
      );
      await store.write('tqsdk', [quote(monthMain, 'TEST.M2612', monday)], []);
      assert.equal(
        (await store.bars('tqsdk', monthMain, MONTH_DURATION))[0].amount,
        null,
        'a month spanning different contracts keeps source data',
      );
    } finally {
      await store.request(`DROP DATABASE ${database}`);
    }
  },
);
