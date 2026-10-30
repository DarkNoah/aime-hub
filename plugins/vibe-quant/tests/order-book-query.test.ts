import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import type { OrderBook } from '../shared.js';

const config = {
  engine: 'tqsdk',
  tqUser: 'fixture',
  tqPassword: 'fixture',
  clickhouseUrl: 'http://127.0.0.1:18124',
  clickhouseDatabase: 'vibe_quant',
  clickhouseUser: 'test',
  clickhousePassword: 'test-only-local',
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 2,
  pollSeconds: 5,
  historyBars: 1000,
  maxSubscriptions: 1,
};

test(
  'real ClickHouse retains same-source-time depth changes and deduplicates retried snapshots',
  { skip: process.env.QUANT_INTEGRATION !== '1' },
  async () => {
    const store = new MarketStore(parseConfig(config));
    await store.initialize();
    await store.initialize(); // Additive upgrade is safe for existing quote/bar tables.
    const book: OrderBook = {
      snapshotId: randomUUID(),
      symbol: `TEST.${randomUUID()}`,
      sourceTime: 1792114200,
      receivedAt: Date.now() / 1000,
      timePrecision: 'exchange',
      volumeUnit: 'source',
      underlying: 'CFFEX.IM2610',
      bidPrices: [8000, 7999.8, null, null, null],
      bidVolumes: [10, 20, null, null, null],
      askPrices: [8000.2, 8000.4, null, null, null],
      askVolumes: [15, 25, null, null, null],
    };
    const changed = {
      ...book,
      snapshotId: randomUUID(),
      receivedAt: book.receivedAt + 1,
      bidVolumes: [30, 20, null, null, null],
    };
    await store.write('tqsdk', [], [], [book, changed]);
    await store.write('tqsdk', [], [], [book, changed]);
    await store.write(
      'tdx',
      [],
      [],
      [{ ...book, sourceTime: null, timePrecision: 'unknown' }],
    );
    assert.deepEqual(await store.orderBooks('tqsdk', [book.symbol]), [changed]);
    assert.equal(
      (await store.orderBooks('tdx', [book.symbol]))[0].sourceTime,
      null,
    );
    assert.deepEqual(await store.orderBooks('tushare', [book.symbol]), []);
    assert.deepEqual(await store.orderBooks('tqsdk', []), []);
    const url = new URL(config.clickhouseUrl);
    url.searchParams.set(
      'query',
      'SELECT count() FROM vibe_quant.order_books FINAL WHERE engine = {engine:String} AND symbol = {symbol:String}',
    );
    url.searchParams.set('param_engine', 'tqsdk');
    url.searchParams.set('param_symbol', book.symbol);
    const count = await fetch(url, {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': config.clickhouseUser,
        'X-ClickHouse-Key': config.clickhousePassword,
      },
    });
    assert.equal(count.status, 200);
    assert.equal(
      (await count.text()).trim(),
      '2',
      'observations survive source-time collisions; retries add no duplicates',
    );
    const empty: OrderBook = {
      ...changed,
      snapshotId: randomUUID(),
      receivedAt: changed.receivedAt + 1,
      bidPrices: [null],
      bidVolumes: [null],
      askPrices: [null],
      askVolumes: [null],
    };
    await store.write('tqsdk', [], [], [empty]);
    assert.deepEqual(
      await store.orderBooks('tqsdk', [book.symbol]),
      [empty],
      'empty snapshots clear stale depth',
    );
    // A later correction to an older key must not become the latest snapshot.
    // UUID ordering breaks receipt-time ties; FINAL still selects corrections
    // to the winning key, even before background merges deduplicate retries.
    const tied = {
      ...empty,
      snapshotId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      bidVolumes: [42],
    };
    const other = {
      ...book,
      symbol: `TEST.${randomUUID()}`,
      receivedAt: empty.receivedAt + 1,
    };
    await store.write('tqsdk', [], [], [tied, other]);
    const corrected = { ...tied, bidVolumes: [43] };
    await store.write(
      'tqsdk',
      [],
      [],
      [{ ...book, bidVolumes: [999] }, corrected],
    );
    assert.deepEqual(
      await store.orderBooks('tqsdk', [
        book.symbol,
        other.symbol,
        book.symbol,
        `TEST.${randomUUID()}`,
      ]),
      [other, corrected],
      'latest keys isolate symbols, ignore late old retries and retain corrections',
    );
  },
);
