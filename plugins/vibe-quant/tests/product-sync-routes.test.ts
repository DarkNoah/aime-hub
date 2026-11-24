import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { Instrument } from '../shared.js';
import { parseConfig } from '../server/config.js';
import { MarketStore } from '../server/clickhouse.js';
import { StateStore } from '../server/state-store.js';
import { ProductSyncStore } from '../server/product-sync/store.js';
import { productSyncRoutes } from '../server/product-sync/routes.js';
import { watchlistRoutes } from '../server/watchlist-routes.js';

test('a saved selection uses the authenticated account, and rejects wildcards and non-Tq engines', async () => {
  const config = { engine: 'tqsdk', clickhouseReadOnly: true } as const;
  let engine: 'tqsdk' | 'tdx' = 'tqsdk';
  const products = {
    async overview() {
      return { options: [], matched: 0, ready: 0, selectedContracts: 0 };
    },
    async contracts() {
      return { items: [], nextCursor: null };
    },
    async setSelected(
      source: string,
      userId: string,
      key: string,
      selected: boolean,
    ) {
      assert.deepEqual(
        [source, userId, key, selected],
        ['tqsdk', 'reader', 'CFFEX.MO', true],
      );
      return true;
    },
  };
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'reader');
    await next();
  });
  app.route(
    '/product-sync',
    productSyncRoutes(() => ({ config: { ...config, engine }, products })),
  );
  const select = (key: string) =>
    app.request('/product-sync', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, selected: true }),
    });
  assert.equal((await select('CFFEX.*')).status, 400);
  assert.equal((await select('CFFEX.MO')).status, 200);
  assert.equal(
    (await (await app.request('/product-sync')).json()).writable,
    false,
  );
  engine = 'tdx';
  assert.equal((await select('CFFEX.MO')).status, 400);
});

test(
  'real ClickHouse: browse the full chain and open saved bars at the live limit and after expiry',
  { skip: process.env.QUANT_INTEGRATION !== '1' },
  async (t) => {
    const config = parseConfig({
      engine: 'tqsdk',
      tqUser: 'fixture',
      tqPassword: 'fixture',
      clickhouseUrl: 'http://127.0.0.1:18124',
      clickhouseUser: 'test',
      clickhousePassword: 'test-only-local',
      clickhouseDatabase: `quant_watch_${randomUUID().replaceAll('-', '')}`,
      flushSeconds: 1,
      pollSeconds: 5,
      historyBars: 100,
      maxSubscriptions: 1,
      beforeOpenMinutes: 5,
      afterCloseMinutes: 10,
    });
    const state = new StateStore(config);
    const store = new MarketStore(config);
    const products = new ProductSyncStore(config);
    await state.request(`CREATE DATABASE ${config.clickhouseDatabase}`);
    t.after(() => state.request(`DROP DATABASE ${config.clickhouseDatabase}`));
    await state.initialize();
    await store.initialize();
    await products.initialize();
    const app = new Hono<PluginHttpEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', 'reader');
      await next();
    });
    app.route(
      '/',
      watchlistRoutes(() => ({ config, state, store })),
    );
    app.route(
      '/product-sync',
      productSyncRoutes(() => ({ config, products })),
    );
    const write = (path: string, method: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const catalog: Instrument[] = Array.from({ length: 64 }, (_, i) => ({
      symbol: `CFFEX.MO2701-C-${5000 + i * 50}`,
      name: '中证1000',
      exchange: 'CFFEX',
      product: 'MO',
      kind: 'option',
      expired: false,
      priceTick: 0.2,
      underlying: 'SSE.000852',
    }));
    const [live, saved, empty] = catalog;
    await state.saveCatalog('tqsdk', catalog);
    assert.equal(
      (await write('/product-sync', 'PUT', { key: 'CFFEX.MO', selected: true }))
        .status,
      200,
    );
    assert.equal(
      (await (await app.request('/product-sync')).json()).matched,
      64,
    );
    assert.deepEqual(await (await app.request('/watchlist')).json(), []);
    const timestamp = 1700000040;
    await store.write(
      'tqsdk',
      [],
      [
        {
          symbol: saved.symbol,
          duration: 60,
          time: timestamp,
          open: 1,
          high: 2,
          low: 1,
          close: 2,
          volume: 10,
        },
      ],
    );
    const page = await (await app.request('/instruments?q=MO&paged=1')).json();
    assert.equal(page.items.length, 60);
    assert.equal(
      page.items.find((item: Instrument) => item.symbol === saved.symbol)
        .localHistory,
      true,
    );
    const next = await (
      await app.request(
        `/instruments?q=MO&paged=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      )
    ).json();
    assert.equal(next.items.length, 4);
    assert.equal(next.nextCursor, null);
    assert.equal(
      new Set([...page.items, ...next.items].map((item) => item.symbol)).size,
      64,
    );
    assert.ok(
      Array.isArray(await (await app.request('/instruments?q=MO')).json()),
    );
    const add = (symbol: string) => write('/watchlist', 'POST', { symbol });
    assert.equal((await (await add(live.symbol)).json()).enabled, true);
    assert.equal((await (await add(saved.symbol)).json()).enabled, false);
    assert.equal((await add(empty.symbol)).status, 409);
    assert.equal(await state.owns('reader', saved.symbol), true);
    assert.equal(
      (await store.bars('tqsdk', saved.symbol, 60, { rebuildTicks: false }))[0]
        .close,
      2,
    );
    await state.acquireLease('tqsdk', 'fixture');
    await products.record('tqsdk', 'fixture', [
      {
        symbol: saved.symbol,
        firstBarAt: timestamp,
        lastBarAt: timestamp,
        latest: { 60: timestamp },
        outcome: 'partial',
      },
    ]);
    await state.saveCatalog('tqsdk', [{ ...saved, expired: true }]);
    const expired = await (
      await app.request(`/instruments?paged=1&q=${saved.symbol}`)
    ).json();
    assert.equal(expired.items[0].expired, true);
    assert.equal(expired.items[0].localHistory, true);
    const mixed = await state.searchPage(
      'tqsdk',
      'MO2701',
      'option',
      undefined,
      true,
    );
    const mixedTail = await state.searchPage(
      'tqsdk',
      'MO2701',
      'option',
      { rank: 1, symbol: mixed.items.at(-1)!.symbol },
      true,
    );
    assert.equal(
      new Set([...mixed.items, ...mixedTail.items].map((row) => row.symbol))
        .size,
      catalog.length,
    );
    assert.equal(mixedTail.items.at(-1)?.symbol, saved.symbol);
    assert.equal(mixedTail.nextCursor, null);
    await app.request(`/watchlist/${saved.symbol}`, { method: 'DELETE' });
    assert.equal((await (await add(saved.symbol)).json()).enabled, false);
    assert.deepEqual(await state.subscriptions('tqsdk'), [live.symbol]);

    // Old self-selected contracts and manual imports may predate product archive progress.
    const old = {
      ...live,
      symbol: 'CFFEX.IM2610',
      name: '中证1000十月',
      kind: 'future' as const,
      expired: true,
    };
    const missing = 'CFFEX.IM2609';
    const legacy = [
      old.symbol,
      missing,
      'SHFE.au2606C800',
      'SSE.10008000',
      'KQ.m@CFFEX.IM',
      ...Array.from(
        { length: 63 },
        (_, n) => `CFFEX.IO2608-P-${4000 + n * 50}`,
      ),
    ];
    await state.saveCatalog('tqsdk', [old, { ...old, symbol: 'CFFEX.IM2501' }]);
    await store.write(
      'tqsdk',
      [],
      legacy.map((symbol) => ({
        symbol,
        duration: 300,
        time: timestamp,
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 5,
      })),
    );
    const search = async (q: string, kind = 'all') =>
      (
        await (
          await app.request(
            `/instruments?paged=1&q=${encodeURIComponent(q)}&kind=${kind}`,
          )
        ).json()
      ).items as Instrument[];
    assert.equal((await search('IM2610', 'future'))[0].expired, true);
    assert.equal((await search('十月', 'future'))[0].symbol, old.symbol);
    assert.equal((await search('IM2609', 'future'))[0].historyOnly, true);
    assert.equal((await search('IM2609', 'future'))[0].expired, false);
    assert.equal((await search('IM2609', 'option')).length, 0);
    assert.equal((await search('au2606', 'option'))[0].symbol, legacy[2]);
    assert.equal((await search('10008000', 'option'))[0].symbol, legacy[3]);
    assert.equal((await search('IM主连'))[0].symbol, legacy[4]);
    assert.equal((await search('IM2501')).length, 0);
    const archivePage = await state.searchPage(
      'tqsdk',
      'IO2608',
      'option',
      undefined,
      true,
    );
    const archiveTail = await state.searchPage(
      'tqsdk',
      'IO2608',
      'option',
      { rank: 2, symbol: archivePage.items.at(-1)!.symbol },
      true,
    );
    assert.match(archivePage.nextCursor!, /^2:CFFEX\.IO2608/);
    assert.equal(archiveTail.nextCursor, null);
    assert.equal(
      new Set(
        [...archivePage.items, ...archiveTail.items].map((row) => row.symbol),
      ).size,
      63,
    );
    assert.equal(
      (await state.viewInstrument('tqsdk', missing))?.historyOnly,
      true,
    );
    assert.equal(
      await state.viewInstrument('tqsdk', 'CFFEX.IM2501'),
      undefined,
    );
    assert.equal(await state.viewInstrument('tdx', missing), undefined);
    assert.deepEqual(await store.storedDurations('tqsdk', missing), [300]);
    assert.equal((await (await add(missing)).json()).enabled, false);
    assert.ok(
      (await state.watchlist('reader', 'tqsdk')).some(
        (row) => row.symbol === missing && row.historyOnly,
      ),
    );
    await app.request(`/watchlist/${missing}`, { method: 'DELETE' });
    assert.equal(await state.owns('reader', missing), false);
    assert.equal((await search('IM2609'))[0].localHistory, true);
    assert.deepEqual(await state.subscriptions('tqsdk'), [live.symbol]);
  },
);
