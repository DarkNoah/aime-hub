import assert from 'node:assert/strict';
import test from 'node:test';
import { TradeCalendar } from '../server/trades/calendar';
import {
  collectTradePages,
  futureTradeTime,
  normalizeTrades,
} from '../server/trades/provider';
import { tradeInstrument } from '../server/trades/symbols';
import { TradeDataError, type TradeDay } from '../server/trades/types';
import { TradeService } from '../server/trades/service';
import type { TradeStore } from '../server/trades/store';
import { parseConfig } from '../server/config';
import type { ExTradeTick, TradeItem } from 'node-tdx-market';

const at = (value: string) => Date.parse(`${value}+08:00`) / 1000;
const signal = () => new AbortController().signal;
const calendar = new TradeCalendar([
  '2026-10-22',
  '2026-10-23',
  '2026-10-26',
  '2026-10-27',
]);
const config = parseConfig({
  engine: 'tdx',
  tdxServers: '127.0.0.1:7709',
  clickhouseUrl: 'http://127.0.0.1:18128',
  clickhouseDatabase: 'test',
  clickhouseUser: 'default',
  clickhousePassword: 'fixture-only',
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 2,
  pollSeconds: 5,
  historyBars: 1000,
  maxSubscriptions: 100,
});
const day: TradeDay = {
  symbol: 'CFFEX.IM2611',
  date: '2026-10-23',
  source: 'tdx-exhq-history',
  sourceSymbol: 'IM2611',
  market: 47,
  fetchedAt: at('2026-10-23T15:00:00'),
  isFinal: true,
  trades: [],
};

test('symbols map to the same TDX markets and codes without altering market engine', () => {
  for (const [symbol, code, market] of [
    ['CFFEX.IM2611', 'IM2611', 47],
    ['SHFE.rb2701', 'RB2701', 30],
    ['DCE.m2701', 'M2701', 29],
    ['CZCE.SR701', 'SR701', 28],
    ['INE.sc2612', 'SC2612', 30],
    ['GFEX.si2612', 'SI2612', 66],
    ['SSE.600036', 'sh600036', 1],
    ['SZSE.159915', 'sz159915', 0],
  ] as const) {
    const value = tradeInstrument(symbol);
    assert.equal(value.code, code);
    assert.equal(value.market, market);
  }
  for (const symbol of [
    'SSE.000852',
    'SZSE.399001',
    'KQ.i@CFFEX.IM',
    'CFFEX.MO2611-C-6000',
    'CFFEX.IM2613',
  ])
    assert.throws(() => tradeInstrument(symbol), TradeDataError);
});

test('night prints retain Friday evening and Saturday morning for Monday trading date', () => {
  const gold = tradeInstrument('SHFE.au2612');
  assert.equal(
    futureTradeTime(
      '2026-10-26',
      { hour: 21, minute: 0, second: 1 },
      gold,
      calendar,
    ),
    at('2026-10-23T21:00:01'),
  );
  assert.equal(
    futureTradeTime(
      '2026-10-26',
      { hour: 24, minute: 30, second: 2 },
      gold,
      calendar,
    ),
    at('2026-10-24T00:30:02'),
  );
  assert.equal(
    futureTradeTime(
      '2026-10-26',
      { hour: 9, minute: 30, second: 0 },
      gold,
      calendar,
    ),
    at('2026-10-26T09:30:00'),
  );
  assert.throws(() => calendar.resolve('2026-10-28'), TradeDataError);
});

test('direction, prices, precision and repeated prints match stock-rl normalization', () => {
  const raw: ExTradeTick = {
    hour: 10,
    minute: 0,
    second: 3,
    price: 6500200,
    volume: 2,
    zengCang: 1,
    nature: 3,
    natureName: '多开',
    direction: 1,
  };
  const future = normalizeTrades(
    [raw, raw, { ...raw, direction: -1 }, { ...raw, direction: 0 }],
    '2026-10-23',
    tradeInstrument(day.symbol),
    calendar,
  );
  assert.deepEqual(
    future.map((t) => t.side),
    ['buy', 'buy', 'sell', 'unknown'],
  );
  assert.equal(future[0].price, 6500.2);
  assert.equal(future[0].precision, 'second');
  assert.equal(
    future.reduce((n, t) => n + t.size, 0),
    8,
  );
  const stock: TradeItem = {
    time: '10:00',
    price: 42100,
    volume: 2,
    direction: 0,
  };
  assert.deepEqual(
    normalizeTrades(
      [
        stock,
        { ...stock, direction: 1 },
        // The live public feed also returns vendor values outside the SDK enum.
        { ...stock, direction: 5 } as unknown as TradeItem,
      ],
      '2026-10-23',
      tradeInstrument('SSE.600036'),
      calendar,
    ).map((t) => t.side),
    ['buy', 'sell', 'unknown'],
  );
  assert.equal(
    normalizeTrades(
      [{ ...stock, price: 2190 }],
      '2026-10-23',
      tradeInstrument('SSE.510300'),
      calendar,
    )[0].price,
    2.19,
  );
  assert.throws(
    () =>
      normalizeTrades(
        [{ ...raw, volume: NaN }],
        '2026-10-23',
        tradeInstrument(day.symbol),
        calendar,
      ),
    TradeDataError,
  );
});

test('historical pagination consumes actual page lengths and preserves identical prints', async () => {
  const rows = [1, 1, 2, 3, 4, 4, 5];
  const offsets: number[] = [];
  const actual = await collectTradePages(async (offset) => {
    offsets.push(offset);
    return rows.slice(offset, offset + 3);
  }, signal());
  assert.deepEqual(actual, rows);
  assert.deepEqual(offsets, [0, 3, 6, 7]);
  await assert.rejects(
    collectTradePages(async () => [1, 2], signal()),
    /重复/,
  );
});

test('live pagination trims moving page overlap without losing identical prints inside windows', async () => {
  const initial = Array.from({ length: 70 }, (_, i) => ({ id: i }));
  const current = [...initial];
  let calls = 0;
  const fetched = await collectTradePages(
    async (offset) => {
      if (calls++ > 0 && calls < 4) current.push({ id: current.length });
      const end = current.length - offset;
      return end <= 0 ? [] : current.slice(Math.max(0, end - 20), end);
    },
    signal(),
    true,
  );
  assert.deepEqual(
    fetched.sort((a, b) => a.id - b.id),
    initial,
  );
});

test('cancellation stops pagination without requesting or committing later pages', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    collectTradePages(async () => {
      calls++;
      controller.abort(new Error('stop'));
      return [1, 2];
    }, controller.signal),
    /stop/,
  );
  assert.equal(calls, 1);
});

function storeFixture(saved?: TradeDay) {
  const writes: TradeDay[] = [];
  return {
    writes,
    store: {
      initialize: async () => {},
      readDay: async () => saved,
      saveDay: async (next: TradeDay) => {
        writes.push(next);
        saved = next;
      },
    } as unknown as TradeStore,
  };
}

test('final days use storage; stale prefixes refresh; read-only never fetches or saves', async () => {
  let requests = 0;
  const provider = {
    readDay: async () => {
      requests++;
      return day;
    },
  };
  const final = storeFixture(day);
  await new TradeService(config, final.store, provider).readDay(
    day.symbol,
    day.date,
    signal(),
  );
  assert.equal(requests, 0);
  const old = storeFixture({ ...day, isFinal: false, fetchedAt: 1 });
  await new TradeService(config, old.store, provider).readDay(
    day.symbol,
    day.date,
    signal(),
  );
  assert.equal(requests, 1);
  assert.equal(old.writes.length, 1);
  const missing = storeFixture();
  await assert.rejects(
    new TradeService(
      { ...config, clickhouseReadOnly: true },
      missing.store,
      provider,
    ).readDay(day.symbol, day.date, signal()),
    /只读/,
  );
  assert.equal(requests, 1);
  assert.equal(missing.writes.length, 0);
});

test('concurrent readers share one request and cancellation by one reader does not stop the other', async () => {
  const fixture = storeFixture();
  let finish!: (day: TradeDay) => void;
  let providerSignal!: AbortSignal;
  let requests = 0;
  const service = new TradeService(config, fixture.store, {
    readDay: async (_symbol, _date, sourceSignal) => {
      requests++;
      providerSignal = sourceSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const controller = new AbortController();
  const first = service.readDay(day.symbol, day.date, controller.signal);
  const second = service.readDay(day.symbol, day.date, signal());
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('cancel one'));
  await assert.rejects(first, /cancel one/);
  assert.equal(providerSignal.aborted, false);
  finish(day);
  assert.equal(await second, day);
  assert.equal(requests, 1);
  assert.equal(fixture.writes.length, 1);
  await service.stop();
});

test('cancelling the last reader aborts the provider and never saves partial data', async () => {
  const fixture = storeFixture();
  const service = new TradeService(config, fixture.store, {
    readDay: async (_symbol, _date, sourceSignal) =>
      new Promise((_resolve, reject) => {
        sourceSignal.addEventListener(
          'abort',
          () => reject(sourceSignal.reason),
          { once: true },
        );
      }),
  });
  const controller = new AbortController();
  const pending = service.readDay(day.symbol, day.date, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
  await service.stop();
  assert.equal(fixture.writes.length, 0);
});
