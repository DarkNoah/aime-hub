import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Hono } from 'hono';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import createServer from '../server/index.js';
import database from '../server/database.js';
import { ClickHouseClient } from '../server/clickhouse-client.js';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import { createPluginRuntime } from '../../../apps/server/src/modules/plugins/runtime.js';
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
  'real ClickHouse deduplicates retries and isolates data engines',
  { skip: process.env.QUANT_INTEGRATION !== '1' },
  async () => {
    const store = new MarketStore(parseConfig(config));
    await store.initialize();
    const symbol = `TEST.${randomUUID()}`;
    const time = Math.floor(Date.now() / 1000) - 120;
    const original = {
      symbol,
      time,
      duration: 60,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 100,
    };
    await store.write('tqsdk', [], [original]);
    await store.write('tqsdk', [], [{ ...original, close: 12 }]);
    await store.write('tdx', [], [{ ...original, close: 10 }]);
    const rows = await store.bars('tqsdk', symbol, 60);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].close, 12);
    assert.equal((await store.bars('tdx', symbol, 60))[0].close, 10);
    assert.equal((await store.bars('tqsdk', symbol, 60, time)).length, 0);
    const quote = {
      symbol,
      time,
      last: 11,
      preClose: 10,
      open: 10,
      high: 12,
      low: 9,
      volume: 100,
      amount: 1000,
      openInterest: null,
      bid: null,
      ask: null,
      underlying: '',
    };
    await store.write('tqsdk', [quote], []);
    await store.write('tqsdk', [{ ...quote, last: 12 }], []);
    assert.equal((await store.quotes('tqsdk', [symbol]))[0].last, 12);
    assert.equal((await store.quotes('tushare', [symbol])).length, 0);
  },
);

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
  },
);

test(
  'real ClickHouse SELECT-only account displays live data without creating tables or inserting rows',
  { skip: process.env.QUANT_INTEGRATION !== '1' },
  async () => {
    const admin = async (query: string) => {
      const url = new URL(config.clickhouseUrl);
      url.searchParams.set('query', query);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-ClickHouse-User': config.clickhouseUser,
          'X-ClickHouse-Key': config.clickhousePassword,
        },
      });
      assert.equal(response.status, 200);
      return (await response.text()).trim();
    };
    const user = `reader_${randomUUID().replaceAll('-', '')}`;
    const symbol = `TEST.${randomUUID()}`;
    const bar = {
      symbol,
      time: Math.floor(Date.now() / 1000) - 120,
      duration: 60,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 100,
    };
    const writer = new MarketStore(parseConfig(config));
    await writer.initialize();
    await writer.write('tqsdk', [], [bar]);
    await admin(
      `CREATE USER ${user} IDENTIFIED BY 'local-read-only' SETTINGS readonly = 1`,
    );
    try {
      await admin(`GRANT SELECT ON vibe_quant.* TO ${user}`);
      const reader = new MarketStore(
        parseConfig({
          ...config,
          clickhouseUser: user,
          clickhousePassword: 'local-read-only',
          clickhouseReadOnly: true,
        }),
      );
      await reader.initialize();
      const live = { ...bar, close: 12 };
      const next = { ...bar, time: bar.time + 60 };
      const book: OrderBook = {
        symbol,
        snapshotId: randomUUID(),
        sourceTime: null,
        receivedAt: Date.now() / 1000,
        timePrecision: 'unknown',
        bidPrices: [10],
        bidVolumes: [20],
        askPrices: [12],
        askVolumes: [30],
        volumeUnit: 'source',
        underlying: '',
      };
      const quote = {
        symbol,
        time: bar.time,
        last: 12,
        preClose: 10,
        open: 10,
        high: 12,
        low: 9,
        volume: 100,
        amount: 1200,
        openInterest: null,
        bid: 10,
        ask: 12,
        underlying: '',
      };
      await reader.write('tqsdk', [quote], [live, next], [book]);
      assert.deepEqual(await reader.bars('tqsdk', symbol, 60), [live, next]);
      assert.deepEqual(await reader.bars('tqsdk', symbol, 60, next.time), [
        live,
      ]);
      assert.deepEqual(await reader.quotes('tqsdk', [symbol]), [quote]);
      assert.deepEqual(await reader.orderBooks('tqsdk', [symbol]), [book]);
      assert.deepEqual(await writer.bars('tqsdk', symbol, 60), [
        { ...bar, amount: null },
      ]);
      assert.deepEqual(await writer.quotes('tqsdk', [symbol]), []);
      assert.deepEqual(await writer.orderBooks('tqsdk', [symbol]), []);
      assert.equal(
        await admin(
          `SELECT count() FROM vibe_quant.bars WHERE symbol = '${symbol}'`,
        ),
        '1',
      );
    } finally {
      await admin(`DROP USER ${user}`);
    }
  },
);

test(
  'PostgreSQL legacy migration and ClickHouse API enforce ownership, limits, toggles and search',
  { skip: process.env.QUANT_INTEGRATION !== '1' || !process.env.DATABASE_URL },
  async () => {
    const schema = `quant_test_${randomUUID().replaceAll('-', '')}`;
    const apiConfig = { ...config, clickhouseDatabase: schema, newsEnabled: false, newsDatabase: schema };
    const clickhouse = new ClickHouseClient(parseConfig(apiConfig));
    await clickhouse.request(`CREATE DATABASE ${schema}`);
    const admin = await new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const db = await new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      extra: { options: `-c search_path=${schema}` },
    }).initialize();
    const plugin = createServer({
      id: 'vibe-quant',
      database: db,
      runtime: createPluginRuntime(
        { id: 'vibe-quant', workspace: true },
        {
          applicationRoot: process.cwd(),
          workspaceRoot: '/tmp/unused-quant-workspace',
        },
      ),
      assertEnabled: async () => {
        throw new Error('Test prevents background producer startup');
      },
    });
    try {
      await db.query('CREATE TABLE users (id text PRIMARY KEY)');
      await db.query("INSERT INTO users VALUES ('alice'), ('bob')");
      const runner = db.createQueryRunner();
      await new database.migrations[0]().up(runner);
      await runner.release();
      const instruments = [
        { symbol: 'SSE.000852', name: '中证1000', kind: 'stock' },
        { symbol: 'CFFEX.IM2610', name: '中证1000期货', kind: 'future' },
        { symbol: 'KQ.m@CFFEX.IM', name: 'IM主连', kind: 'continuous' },
        { symbol: 'CFFEX.MO2610-C-8000', name: 'MO期权', kind: 'option' },
      ].map((item) => ({
        ...item,
        exchange: 'CFFEX',
        product: '',
        priceTick: 0.2,
        underlying: '',
        expired: false,
      }));
      for (const item of instruments)
        await db.query(
          'INSERT INTO plugin_vibe_quant_instruments (engine,symbol,metadata) VALUES ($1,$2,$3)',
          ['tqsdk', item.symbol, item],
        );
      await plugin.onEnable!({ config: apiConfig });
      const app = new Hono<PluginHttpEnv>();
      app.use('*', async (c, next) => {
        c.set('userId', c.req.header('x-user') ?? 'alice');
        c.set('isAdmin', false);
        await next();
      });
      app.route('/', plugin.api!);
      const request = (
        path: string,
        user = 'alice',
        method = 'GET',
        body?: object,
      ) =>
        app.request(path, {
          method,
          headers: { 'x-user': user, 'Content-Type': 'application/json' },
          body: body && JSON.stringify(body),
        });
      assert.equal(
        (await request('/watchlist', 'alice', 'POST', { symbol: 'SSE.000852' }))
          .status,
        201,
      );
      assert.equal((await request('/watchlist', 'bob')).status, 200);
      assert.deepEqual(await (await request('/watchlist', 'bob')).json(), []);
      const store = new MarketStore(parseConfig(apiConfig));
      await store.write(
        'tqsdk',
        [],
        [],
        [
          {
            snapshotId: randomUUID(),
            symbol: 'SSE.000852',
            sourceTime: null,
            receivedAt: Date.now() / 1000,
            timePrecision: 'unknown',
            bidPrices: [10],
            bidVolumes: [50],
            askPrices: [11],
            askVolumes: [60],
            volumeUnit: 'source',
            underlying: '',
          },
        ],
      );
      assert.equal(
        (await (await request('/snapshot', 'alice')).json()).orderBooks[0]
          .bidVolumes[0],
        50,
      );
      assert.deepEqual(
        (await (await request('/snapshot', 'bob')).json()).orderBooks,
        [],
      );
      assert.equal(
        (await request('/bars?symbol=SSE.000852', 'bob')).status,
        404,
      );
      assert.equal(
        (
          await request(
            '/ticks/validation?symbol=SSE.000852&tradingDay=2026-10-19',
            'bob',
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            '/ticks/validation?symbol=SSE.000852&tradingDay=2026-02-30',
            'alice',
          )
        ).status,
        400,
      );
      const tickCheck = await request(
        '/ticks/validation?symbol=SSE.000852&tradingDay=2026-10-19',
        'alice',
      );
      assert.equal(tickCheck.status, 200);
      assert.equal((await tickCheck.json()).state, 'empty');
      assert.equal(
        (await request('/watchlist', 'bob', 'POST', { symbol: 'SSE.000852' }))
          .status,
        201,
      );
      assert.equal(
        (
          await request('/watchlist', 'alice', 'POST', {
            symbol: 'CFFEX.IM2610',
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request('/watchlist/SSE.000852', 'alice', 'PATCH', {
            enabled: false,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request('/watchlist', 'alice', 'POST', {
            symbol: 'CFFEX.IM2610',
          })
        ).status,
        409,
        'bob still subscribes',
      );
      await request('/watchlist/SSE.000852', 'bob', 'DELETE');
      assert.equal(
        (
          await request('/watchlist', 'alice', 'POST', {
            symbol: 'CFFEX.IM2610',
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await request('/watchlist/SSE.000852', 'alice', 'PATCH', {
            enabled: true,
          })
        ).status,
        409,
      );
      const search = await (
        await request('/instruments?q=IM%E4%B8%BB%E8%BF%9E')
      ).json();
      assert.deepEqual(
        search.map((item: { symbol: string }) => item.symbol),
        ['KQ.m@CFFEX.IM'],
      );
      const options = await (await request('/instruments?q=MOxxx')).json();
      assert.equal(options[0].symbol, 'CFFEX.MO2610-C-8000');
      await request('/watchlist/CFFEX.IM2610', 'bob', 'DELETE');
      assert.equal(
        (await (await request('/watchlist', 'alice')).json()).length,
        2,
        'another user cannot delete my records',
      );
    } finally {
      await plugin.onDisable!({ config: apiConfig });
      await clickhouse.request(`DROP DATABASE ${schema}`);
      await db.destroy();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  },
);
