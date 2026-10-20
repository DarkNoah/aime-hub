import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import { LiveMarket } from '../server/live-market.js';
import type { Bar, OrderBook, Quote } from '../shared.js';

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
const bar: Bar = {
  symbol: 'SSE.600000',
  duration: 60,
  time: 100,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 100,
};
const quote: Quote = {
  symbol: bar.symbol,
  time: 100,
  last: 11,
  preClose: 10,
  open: 10,
  high: 12,
  low: 9,
  volume: 100,
  amount: 1100,
  openInterest: null,
  bid: 10,
  ask: 12,
  underlying: '',
};
const book: OrderBook = {
  symbol: bar.symbol,
  snapshotId: '32e6b90a-a05d-4c64-88de-4b43819dd887',
  sourceTime: null,
  receivedAt: 100,
  timePrecision: 'unknown',
  bidPrices: [10],
  bidVolumes: [20],
  askPrices: [12],
  askVolumes: [30],
  volumeUnit: 'source',
  underlying: '',
};

test('read-only config is opt-in and rejects non-boolean values', () => {
  assert.equal(parseConfig(config).clickhouseReadOnly, false);
  assert.equal(
    parseConfig({ ...config, clickhouseReadOnly: true }).clickhouseReadOnly,
    true,
  );
  assert.throws(() => parseConfig({ ...config, clickhouseReadOnly: 'false' }));
});

test('default mode still creates tables and persists all three data types', async () => {
  const original = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = async (input, init) => {
    const query = new URL(String(input)).searchParams.get('query')!;
    queries.push(query);
    if (query.startsWith('INSERT')) {
      const row = JSON.parse(String(init?.body));
      assert.equal(row.engine, 'tdx');
      assert.equal(row.symbol, bar.symbol);
    }
    return new Response('');
  };
  try {
    const writer = new MarketStore(parseConfig(config));
    await writer.initialize();
    await writer.write('tdx', [quote], [bar], [book]);
    assert.equal(
      queries.filter((query) => query.startsWith('CREATE')).length,
      4,
    );
    assert.equal(
      queries.filter((query) => query.startsWith('INSERT')).length,
      3,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('read-only store only SELECTs and overlays live quotes, empty depth and paginated bars', async () => {
  const original = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('query')!;
    queries.push(query);
    assert.match(
      query,
      /^SELECT /,
      'read-only mode must never issue DDL or INSERT',
    );
    if (query.includes('LIMIT 0')) return new Response('');
    let data: unknown[] = [];
    if (url.searchParams.get('param_engine') === 'tdx') {
      if (query.includes('.quotes')) data = [quote];
      if (query.includes('.order_books')) data = [book];
      if (query.includes('.bars'))
        data = [bar, { ...bar, time: 40 }].filter(
          (row) => row.time < Number(url.searchParams.get('param_before')),
        );
    }
    return Response.json({ data });
  };
  try {
    const store = new MarketStore(
      parseConfig({ ...config, clickhouseReadOnly: true }),
    );
    await store.initialize();
    assert.equal(queries.length, 3);
    const liveQuote = { ...quote, last: 12 };
    const liveBar = { ...bar, close: 12 };
    const nextBar = { ...bar, time: 160 };
    const emptyBook = {
      ...book,
      receivedAt: 101,
      bidPrices: [null],
      askPrices: [null],
    };
    await store.write('tdx', [liveQuote], [liveBar, nextBar], [emptyBook]);
    assert.equal(
      queries.length,
      3,
      'receiving data makes no ClickHouse request',
    );
    assert.deepEqual(await store.quotes('tdx', [bar.symbol]), [liveQuote]);
    assert.deepEqual(await store.orderBooks('tdx', [bar.symbol]), [emptyBook]);
    assert.deepEqual(await store.bars('tdx', bar.symbol, 60), [
      { ...bar, time: 40 },
      liveBar,
      nextBar,
    ]);
    assert.deepEqual(await store.bars('tdx', bar.symbol, 60, 160), [
      { ...bar, time: 40 },
      liveBar,
    ]);
    assert.deepEqual(await store.quotes('tqsdk', [bar.symbol]), []);
    assert.deepEqual(await store.orderBooks('tqsdk', [bar.symbol]), []);
    assert.deepEqual(await store.bars('tqsdk', bar.symbol, 60), []);
    store.retainSymbols('tdx', []);
    assert.deepEqual(await store.quotes('tdx', [bar.symbol]), [quote]);
    assert.deepEqual(await store.bars('tdx', bar.symbol, 60), [
      { ...bar, time: 40 },
      bar,
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('live overlay stays scoped, keeps newer stored data, and bounds each bar series', () => {
  const live = new LiveMarket();
  live.update(
    'tdx',
    [quote],
    Array.from({ length: 1100 }, (_, time) => ({ ...bar, time })),
    [book],
  );
  const bars = live.bars('tdx', bar.symbol, 60, 2000, []);
  assert.equal(bars.length, 1000);
  assert.equal(bars[0].time, 100);
  assert.equal(bars.at(-1)?.time, 1099);
  assert.deepEqual(live.quotes('tdx', [], []), []);
  assert.deepEqual(live.bars('tdx', 'SSE.000852', 60, 2000, []), []);
  assert.deepEqual(live.bars('tdx', bar.symbol, 300, 2000, []), []);
  const newerQuote = { ...quote, time: 101 };
  const newerBook = { ...book, receivedAt: 101 };
  assert.deepEqual(live.quotes('tdx', [bar.symbol], [newerQuote]), [
    newerQuote,
  ]);
  assert.deepEqual(live.orderBooks('tdx', [bar.symbol], [newerBook]), [
    newerBook,
  ]);
  live.update(
    'tdx',
    [{ ...quote, time: 99 }],
    [],
    [{ ...book, receivedAt: 99 }],
  );
  assert.deepEqual(live.quotes('tdx', [bar.symbol], []), [quote]);
  assert.deepEqual(live.orderBooks('tdx', [bar.symbol], []), [book]);
  assert.deepEqual(new LiveMarket().quotes('tdx', [bar.symbol], []), []);
});
