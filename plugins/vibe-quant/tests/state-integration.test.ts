import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PluginContext } from '@app/plugin-sdk/server';
import { StateStore } from '../server/state-store.js';
import { ClickHouseClient } from '../server/clickhouse-client.js';
import { MarketStore } from '../server/clickhouse.js';
import { migrateState } from '../server/migrate-state.js';
import { parseConfig } from '../server/config.js';
import type { Instrument, SyncStatus } from '../shared.js';

const enabled = process.env.QUANT_INTEGRATION === '1';
const base = {
  engine: 'tdx',
  tdxServers: '192.0.2.1:7709',
  clickhouseUrl: 'http://127.0.0.1:18124',
  clickhouseDatabase: 'vibe_quant',
  clickhouseUser: 'test',
  clickhousePassword: 'test-only-local',
  maxSubscriptions: 1,
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 1,
  pollSeconds: 5,
  historyBars: 100,
};
const instrument = (symbol: string): Instrument => ({
  symbol,
  name: symbol,
  kind: 'stock',
  exchange: 'SSE',
  product: '',
  priceTick: 0.01,
  underlying: '',
  expired: false,
});
const status: SyncStatus = {
  engine: 'tdx',
  state: 'syncing',
  message: 'fixture',
  updatedAt: new Date().toISOString(),
  lastWriteAt: null,
  lastReceivedAt: null,
  clickhouseReadOnly: false,
  subscriptions: 1,
  active: 1,
  catalogCount: 2,
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
};
async function setup(t: TestContext) {
  const config = parseConfig({
    ...base,
    clickhouseDatabase: `quant_state_${randomUUID().replaceAll('-', '')}`,
  });
  const admin = new ClickHouseClient(config);
  await admin.request(`CREATE DATABASE ${config.clickhouseDatabase}`);
  t.after(() => admin.request(`DROP DATABASE ${config.clickhouseDatabase}`));
  const state = new StateStore(config);
  await state.initialize();
  await state.saveCatalog('tdx', [
    instrument('SSE.000001'),
    instrument('SSE.000002'),
  ]);
  return { config, admin, state };
}

test(
  'shared ClickHouse state isolates users, survives restart and retains tombstones',
  { skip: !enabled },
  async (t) => {
    const { config, state } = await setup(t);
    assert.equal(await state.catalogCount('tdx'), 2);
    assert.equal(
      await state.setWatch('alice', 'SSE.000001', true, 'add'),
      'ok',
    );
    const other = new StateStore(config); // No shared PostgreSQL or in-memory objects.
    assert.equal((await other.watchlist('alice', 'tdx')).length, 1);
    assert.deepEqual(await other.watchlist('bob', 'tdx'), []);
    assert.equal(await other.setWatch('bob', 'SSE.000001', true, 'add'), 'ok');
    assert.equal(
      await state.setWatch('alice', 'SSE.000002', true, 'add'),
      'limit',
    );
    assert.equal(
      await state.setWatch('alice', 'SSE.000001', false, 'update'),
      'ok',
    );
    assert.deepEqual(await other.subscriptions('tdx'), ['SSE.000001']);
    await other.setWatch('bob', 'SSE.000001', false, 'delete');
    assert.deepEqual(await state.subscriptions('tdx'), []);
    assert.equal(
      await state.setWatch('alice', 'SSE.000002', true, 'add'),
      'ok',
    );
    assert.equal(
      await state.setWatch('bob', 'SSE.000001', true, 'update'),
      'missing',
    );
    await state.completeCatalog('tdx', ['SSE.000001']);
    assert.deepEqual(await state.subscriptions('tdx'), []);
    assert.equal((await state.instrument('tdx', 'SSE.000002'))!.expired, true);
    assert.equal((await state.search('tdx', '00000', 'stock')).length, 1);
    assert.equal((await state.search('tdx', '%', 'all')).length, 0);
    assert.deepEqual(await state.watchlist("alice' OR 1=1 --", 'tdx'), []);
  },
);

test(
  'same and different ClickHouse accounts serialize capacity and fence expired producers',
  { skip: !enabled },
  async (t) => {
    const { config, admin, state } = await setup(t);
    const user = `quant_peer_${randomUUID().replaceAll('-', '')}`;
    await admin.request(`CREATE USER ${user} IDENTIFIED BY 'local-test'`);
    t.after(() => admin.request(`DROP USER ${user}`));
    await admin.request(
      `GRANT SELECT, INSERT ON ${config.clickhouseDatabase}.* TO ${user}`,
    );
    const peer = new StateStore({
      ...config,
      clickhouseUser: user,
      clickhousePassword: 'local-test',
    });
    await peer.initialize(); // Existing tables need SELECT + INSERT, not CREATE.
    for (const second of [new StateStore(config), peer]) {
      const results = await Promise.all([
        state.setWatch('alice', 'SSE.000001', true, 'add'),
        second.setWatch('bob', 'SSE.000002', true, 'add'),
      ]);
      assert.deepEqual(results.sort(), ['limit', 'ok']);
      assert.equal((await state.subscriptions('tdx')).length, 1);
      await state.setWatch('alice', 'SSE.000001', false, 'delete');
      await second.setWatch('bob', 'SSE.000002', false, 'delete');
    }
    const claims = await Promise.all([
      state.acquireLease('tdx', 'one'),
      peer.acquireLease('tdx', 'two'),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const owner = claims[0] ? 'one' : 'two';
    const next = claims[0] ? 'two' : 'one';
    const market = new MarketStore(config);
    await market.initialize();
    const bar = {
      symbol: 'SSE.000001',
      time: Math.floor(Date.now() / 1000),
      duration: 60,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    };
    await market.write('tdx', [], [bar], [], owner);
    await state.saveStatus(owner, status);
    assert.deepEqual(await peer.writerStatus('tdx'), status);
    // Force a lease expiry using the server clock, without waiting a minute.
    await admin.request(
      `INSERT INTO ${admin.table('quant_leases')} SELECT 'tdx', '${owner}', 0, toUInt64(toUnixTimestamp64Micro(now64(6)))`,
    );
    assert.equal(await peer.acquireLease('tdx', next), true);
    await state.releaseLease('tdx', owner); // An old process cannot release its successor.
    assert.equal(await state.acquireLease('tdx', owner), false);
    await assert.rejects(
      market.write('tdx', [], [{ ...bar, close: 2 }], [], owner),
      /WRITER_LEASE_LOST/,
    );
    assert.equal((await market.bars('tdx', bar.symbol, 60))[0].close, 1);
    await market.write('tdx', [], [{ ...bar, close: 3 }], [], next);
    assert.equal((await market.bars('tdx', bar.symbol, 60))[0].close, 3);
  },
);

test(
  'legacy PostgreSQL import is repeatable and never restores deleted or edited records',
  { skip: !enabled },
  async (t) => {
    const { state } = await setup(t);
    const catalog = [
      {
        engine: 'tdx',
        symbol: 'SSE.000001',
        metadata: instrument('SSE.000001'),
      },
    ];
    const watches = [
      { userId: 'alice', symbol: 'SSE.000001', enabled: true, createdAt: 123 },
    ];
    const context = {
      database: {
        query: async (query: string) => {
          if (query.includes('to_regclass'))
            return [{ catalog: true, watches: true, status: true }];
          if (query.includes('FROM plugin_vibe_quant_instruments'))
            return catalog;
          if (query.includes('FROM plugin_vibe_quant_watchlist'))
            return watches;
          if (query.includes('FROM plugin_vibe_quant_status'))
            return [{ payload: status }];
          throw new Error('Unexpected PostgreSQL mutation');
        },
      },
    } as unknown as PluginContext;
    await migrateState(context, state);
    assert.equal((await state.watchlist('alice', 'tdx'))[0].enabled, true);
    await state.setWatch('alice', 'SSE.000001', false, 'update');
    await migrateState(context, state);
    assert.equal((await state.watchlist('alice', 'tdx'))[0].enabled, false);
    await state.setWatch('alice', 'SSE.000001', false, 'delete');
    // A second, independently migrated host has a different fingerprint.
    await state.importLegacy(
      'another-host',
      [{ ...catalog[0], engine: 'tdx' }],
      watches,
      status,
    );
    assert.deepEqual(await state.watchlist('alice', 'tdx'), []);
    assert.equal(await state.migrated('another-host'), true);
  },
);

test(
  'market read-only service persists shared state with no market INSERT or persistent CREATE permissions',
  { skip: !enabled },
  async (t) => {
    const { config, state, admin } = await setup(t);
    const writer = new MarketStore(config);
    await writer.initialize();
    const bar = {
      symbol: 'SSE.000001',
      time: Math.floor(Date.now() / 1000),
      duration: 60,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    };
    await writer.write('tdx', [], [bar]);
    const user = `quant_reader_${randomUUID().replaceAll('-', '')}`;
    await admin.request(`CREATE USER ${user} IDENTIFIED BY 'local-reader'`);
    t.after(() => admin.request(`DROP USER ${user}`));
    await admin.request(
      `GRANT SELECT ON ${config.clickhouseDatabase}.* TO ${user}`,
    );
    await admin.request(`GRANT CREATE TEMPORARY TABLE ON *.* TO ${user}`);
    for (const name of [
      'quant_instruments',
      'quant_watchlist',
      'quant_status',
      'quant_migrations',
    ])
      await admin.request(`GRANT INSERT ON ${admin.table(name)} TO ${user}`);
    const readerConfig = {
      ...config,
      clickhouseReadOnly: true,
      clickhouseUser: user,
      clickhousePassword: 'local-reader',
    };
    const reader = new MarketStore(readerConfig);
    const readerState = new StateStore(readerConfig);
    await reader.initialize();
    await readerState.initialize();
    await readerState.setWatch('reader-user', bar.symbol, true, 'add');
    await readerState.saveCatalog('tdx', [instrument(bar.symbol)]);
    await readerState.saveStatus('reader', {
      ...status,
      clickhouseReadOnly: true,
    });
    await readerState.importLegacy('reader-host', [], []);
    await reader.write('tdx', [], [{ ...bar, close: 2 }]);
    assert.equal((await reader.bars('tdx', bar.symbol, 60))[0].close, 2);
    assert.equal((await writer.bars('tdx', bar.symbol, 60))[0].close, 1);
    assert.deepEqual(await state.subscriptions('tdx'), [bar.symbol]);
    assert.equal((await state.watchlist('reader-user', 'tdx')).length, 1);
    const saved = await admin.rows<{ payload: string }>(
      `SELECT payload FROM ${admin.table('quant_status')} FINAL WHERE instanceId = 'reader'`,
    );
    assert.equal(JSON.parse(saved[0].payload).clickhouseReadOnly, true);
    await readerState.completeCatalog('tdx', []);
    assert.equal((await state.instrument('tdx', bar.symbol))!.expired, true);
  },
);
