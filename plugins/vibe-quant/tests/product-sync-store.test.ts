import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Instrument } from '../shared.js';
import { StateStore } from '../server/state-store.js';
import { ProductSyncStore } from '../server/product-sync/store.js';
import { parseConfig } from '../server/config.js';

const config = parseConfig({
  engine: 'tqsdk',
  tqUser: 'fixture',
  tqPassword: 'fixture',
  clickhouseUrl: 'http://127.0.0.1:18124',
  clickhouseDatabase: 'quant_product_sync_test',
  clickhouseUser: 'test',
  clickhousePassword: 'test-only-local',
  maxSubscriptions: 1,
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 1,
  pollSeconds: 5,
  historyBars: 100,
});

function instrument(
  symbol: string,
  kind: Instrument['kind'],
  underlying = '',
  product = '',
): Instrument {
  return {
    symbol,
    name: symbol,
    kind,
    underlying,
    product,
    exchange: symbol.split('.')[0],
    priceTick: 0.2,
    expired: false,
  };
}

test('exchange wildcards and free-form patterns cannot create a selection', async () => {
  const store = new ProductSyncStore(config);
  for (const unsupported of ['CFFEX.*', '*', 'SHFE.cu%', 'MO', '']) {
    assert.equal(
      await store.setSelected('tqsdk', 'alice', unsupported, true),
      false,
    );
  }
});

test(
  'real ClickHouse expands current product families, pages concrete contracts, and deduplicates private selections',
  {
    skip: process.env.QUANT_INTEGRATION !== '1',
  },
  async (t) => {
    const isolated = {
      ...config,
      clickhouseDatabase: `quant_products_${randomUUID().replaceAll('-', '')}`,
    };
    const state = new StateStore(isolated);
    const store = new ProductSyncStore(isolated);
    await state.request(`CREATE DATABASE ${isolated.clickhouseDatabase}`);
    t.after(() =>
      state.request(`DROP DATABASE ${isolated.clickhouseDatabase}`),
    );
    await state.initialize();
    await store.initialize();
    const options = Array.from({ length: 73 }, (_, i) =>
      instrument(
        `CFFEX.MO2701-C-${5000 + i * 50}`,
        'option',
        'SSE.000852',
        'IM',
      ),
    );
    const put = instrument('CFFEX.MO2702-P-5100', 'option', 'SSE.000852');
    const all = [
      ...options,
      put,
      instrument('CFFEX.IM2703', 'future'),
      instrument('SHFE.cu2703', 'future'),
      instrument('SHFE.cu2703P82000', 'option', 'SHFE.cu2703'),
      instrument('SSE.10090000', 'option', 'SSE.510050'),
      instrument('SSE.510050', 'stock'),
      instrument('KQ.m@CFFEX.IM', 'continuous'),
      instrument('CFFEX.IO2702-C-4000', 'option'),
    ];
    await state.saveCatalog('tqsdk', all);
    const initial = await store.overview('tqsdk', 'alice');
    assert.deepEqual(
      initial.options.map((row) => [row.key, row.total]),
      [
        ['CFFEX.IM', 1],
        ['CFFEX.IO', 1],
        ['CFFEX.MO', 74],
        ['SHFE.CU', 2],
        ['SSE.510050', 1],
      ],
    );
    assert.equal(
      await store.setSelected('tqsdk', 'alice', 'CFFEX.XX', true),
      false,
    );
    assert.equal(
      await store.setSelected('tqsdk', 'alice', 'CFFEX.MO', true),
      true,
    );
    assert.equal(
      await store.setSelected('tqsdk', 'alice', put.symbol, true),
      true,
    );
    assert.equal(
      await store.setSelected('tqsdk', 'bob', put.symbol, true),
      true,
    );
    assert.equal(
      await store.setSelected('tqsdk', 'bob', 'SHFE.cu2703', true),
      true,
    );
    assert.equal((await store.overview('tqsdk', 'alice')).matched, 74);
    assert.equal((await store.overview('tqsdk', 'alice')).selectedContracts, 1);
    assert.equal((await store.overview('tqsdk', 'bob')).matched, 2);
    assert.deepEqual(await state.watchlist('alice', 'tqsdk'), []);
    assert.deepEqual(await state.subscriptions('tqsdk'), []);
    const firstPage = await store.contracts('tqsdk', 'alice', 'CFFEX.MO');
    assert.equal(firstPage.items.length, 60);
    const remainder = await store.contracts(
      'tqsdk',
      'alice',
      'CFFEX.MO',
      '',
      firstPage.nextCursor!,
    );
    assert.equal(remainder.nextCursor, null);
    assert.equal(
      new Set([...firstPage.items, ...remainder.items].map((row) => row.symbol))
        .size,
      74,
    );
    assert.equal(
      (await store.contracts('tqsdk', 'alice', 'CFFEX.MO', '-P-')).items[0]
        .selected,
      true,
    );
    assert.equal((await store.due('tqsdk', 1000)).length, 75);
    await state.saveCatalog('tqsdk', [
      instrument('CFFEX.MO2702-P-5200', 'option', 'SSE.000852'),
    ]);
    assert.equal((await store.due('tqsdk', 1000)).length, 76);

    const writer = 'fixture-writer';
    assert.equal(await state.acquireLease('tqsdk', writer), true);
    // The previous six-period collector could finish some periods without a minute bar.
    const progress = store.table('quant_product_sync_progress');
    await store.request(
      `INSERT INTO ${progress} VALUES
         ('tqsdk', {put:String}, {'60':180,'300':300}, 60, 180, 'partial', 0, 1),
         ('tqsdk', 'SHFE.cu2703', {'300':300}, 0, 0, 'partial', 0, 1)`,
      { put: put.symbol },
    );
    const targets = await store.due('tqsdk', 1000);
    assert.deepEqual(targets.find((t) => t.symbol === put.symbol)?.latest, {
      '60': 180,
    });
    assert.deepEqual(
      targets.find((t) => t.symbol === 'SHFE.cu2703')?.latest,
      {},
    );
    assert.equal((await store.overview('tqsdk', 'bob')).ready, 1);
    const [withMinutes] = (
      await store.contracts('tqsdk', 'alice', 'CFFEX.MO', put.symbol)
    ).items;
    assert.equal(withMinutes.outcome, 'ready');
    const [withoutMinutes] = (
      await store.contracts('tqsdk', 'bob', 'SHFE.CU', 'SHFE.cu2703')
    ).items;
    assert.equal(withoutMinutes.ready, false);
    assert.equal(withoutMinutes.outcome, undefined);
    const result = {
      symbol: put.symbol,
      latest: { '60': 240 },
      firstBarAt: 240,
      lastBarAt: 240,
      outcome: 'ready' as const,
    };
    await assert.rejects(
      store.record('tqsdk', 'wrong-lease', [result]),
      /WRITER_LEASE_LOST/,
    );
    await store.record('tqsdk', writer, [result]);
    await store.record('tqsdk', writer, [
      {
        ...result,
        latest: { '60': 120 },
        firstBarAt: 0,
        lastBarAt: 0,
        outcome: 'error',
      },
    ]);
    const [checkpoint] = await store.rows<{
      latest: Record<string, number>;
      firstBarAt: number;
      lastBarAt: number;
    }>(
      `SELECT latest, firstBarAt, lastBarAt FROM ${progress} FINAL WHERE symbol = {put:String}`,
      { put: put.symbol },
    );
    assert.deepEqual(checkpoint, {
      latest: { '60': 240, '300': 300 },
      firstBarAt: 60,
      lastBarAt: 240,
    });
    assert.equal(
      (await store.due('tqsdk', 1000)).some((row) => row.symbol === put.symbol),
      false,
    );
    assert.equal((await store.overview('tqsdk', 'bob')).ready, 1);

    await store.setSelected('tqsdk', 'alice', 'CFFEX.MO', false);
    assert.equal((await store.due('tqsdk', 1000)).length, 1);
    await state.saveCatalog('tqsdk', [{ ...put, expired: true }]);
    const [expired] = (
      await store.contracts('tqsdk', 'alice', 'CFFEX.MO', '-P-5100')
    ).items;
    assert.equal(expired.expired, true);
    assert.equal(expired.ready, true);
    assert.equal(expired.firstBarAt, 60);
    assert.equal(expired.lastBarAt, 240);
    assert.equal(expired.outcome, 'error');
    assert.equal(
      await store.setSelected('tqsdk', 'alice', put.symbol, true),
      false,
    );
    assert.equal(
      await store.setSelected('tqsdk', 'alice', put.symbol, false),
      true,
    );
    assert.equal(
      (await store.contracts('tqsdk', 'alice', 'CFFEX.MO', '-P-5100')).items
        .length,
      0,
    );
    assert.equal((await store.overview('tqsdk', 'bob')).selectedContracts, 2);
  },
);
