import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { Instrument, SyncStatus } from '../shared.js';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import { marketViewRoutes } from '../server/market-view.js';
import { StrategySubscriptions } from '../server/sdk/subscriptions.js';
import { StateStore } from '../server/state-store.js';
import { MonitorStore } from '../server/signals/store.js';
import { TradeService } from '../server/trades/service.js';

test(
  'real ClickHouse: standalone chart links retain live symbols temporarily and open stored contracts without a favorite',
  {
    skip: process.env.QUANT_INTEGRATION !== '1',
  },
  async (t) => {
    const config = parseConfig({
      engine: 'tqsdk',
      tqUser: 'fixture',
      tqPassword: 'fixture',
      clickhouseUrl: 'http://127.0.0.1:18124',
      clickhouseUser: 'test',
      clickhousePassword: 'test-only-local',
      clickhouseDatabase: `quant_view_${randomUUID().replaceAll('-', '')}`,
      maxSubscriptions: 1,
      flushSeconds: 1,
      pollSeconds: 5,
      historyBars: 100,
      beforeOpenMinutes: 5,
      afterCloseMinutes: 10,
    });
    const state = new StateStore(config);
    const store = new MarketStore(config);
    const subscriptions = new StrategySubscriptions(config);
    await state.request(`CREATE DATABASE ${config.clickhouseDatabase}`);
    t.after(() => state.request(`DROP DATABASE ${config.clickhouseDatabase}`));
    await state.initialize();
    await store.initialize();
    const status: SyncStatus = {
      engine: 'tqsdk',
      state: 'idle',
      message: '',
      updatedAt: null,
      lastWriteAt: null,
      lastReceivedAt: null,
      clickhouseReadOnly: false,
      subscriptions: 0,
      active: 0,
      catalogCount: 0,
      beforeOpenMinutes: 5,
      afterCloseMinutes: 10,
    };
    const app = new Hono<PluginHttpEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', c.req.header('x-owner') ?? 'viewer');
      await next();
    });
    app.route(
      '/',
      marketViewRoutes(() => ({
        config,
        state,
        store,
        subscriptions,
        monitors: new MonitorStore(config, 'fixture'),
        trades: new TradeService(config),
        status: () => status,
      })),
    );
    const show = (id: string, symbol: string, owner = 'viewer') =>
      app.request(`/market-view/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-owner': owner },
        body: JSON.stringify({ symbol }),
      });
    const close = (id: string, symbol: string, owner = 'viewer') =>
      app.request(`/market-view/${id}?symbol=${symbol}`, {
        method: 'DELETE',
        headers: { 'x-owner': owner },
      });
    const live: Instrument = {
      symbol: 'CFFEX.IM2612',
      name: '中证1000期货',
      kind: 'future',
      exchange: 'CFFEX',
      product: 'IM',
      expired: false,
      priceTick: 0.2,
      underlying: '',
    };
    const other = { ...live, symbol: 'CFFEX.IM2701' };
    const previous = 'CFFEX.IM2610';
    await state.saveCatalog('tqsdk', [live, other]);
    const start = 1700010000;
    await store.write(
      'tqsdk',
      [
        {
          symbol: live.symbol,
          time: start,
          last: 106,
          preClose: 100,
          open: 105,
          high: 107,
          low: 100,
          volume: 13,
          openInterest: 51,
          amount: 11,
          bid: 105,
          ask: 106,
          underlying: '',
        },
      ],
      [previous, other.symbol].map((symbol) => ({
        symbol,
        duration: 86400,
        time: start,
        open: 103,
        high: 104,
        low: 102,
        close: 104,
        volume: 5,
      })),
    );
    const liveId = randomUUID();
    assert.equal((await (await show(liveId, live.symbol)).json()).mode, 'live');
    assert.deepEqual(await state.subscriptions('tqsdk'), [live.symbol]);
    assert.deepEqual(await state.watchlist('viewer', 'tqsdk'), []);
    assert.deepEqual(
      (await (await app.request('/snapshot')).json()).quotes,
      [],
    );
    assert.equal(
      (await (await app.request(`/snapshot?symbol=${live.symbol}`)).json())
        .quotes[0].last,
      106,
    );
    assert.equal(
      (await app.request('/snapshot?symbol=TEST.MISSING')).status,
      404,
    );
    const limitId = randomUUID();
    const limited = await (await show(limitId, other.symbol)).json();
    assert.equal(limited.mode, 'limit');
    assert.deepEqual(limited.availableDurations, [86400]);
    const history = await (await show(randomUUID(), previous)).json();
    assert.equal(history.mode, 'history');
    assert.deepEqual(history.availableDurations, [86400]);
    const bars = await (
      await app.request(`/bars?symbol=${previous}&duration=86400`)
    ).json();
    assert.equal(bars[0].close, 104);
    assert.equal((await app.request('/bars?symbol=TEST.MISSING')).status, 404);
    assert.deepEqual(await state.subscriptions('tqsdk'), [live.symbol]);
    await close(liveId, live.symbol, 'someone-else');
    assert.deepEqual(await state.subscriptions('tqsdk'), [live.symbol]);
    await close(liveId, live.symbol);
    assert.deepEqual(await state.subscriptions('tqsdk'), []);
    // An HTTP renewal that was already in flight at close cannot reacquire it.
    await show(liveId, live.symbol);
    assert.deepEqual(await state.subscriptions('tqsdk'), []);
    assert.equal(
      (await (await show(limitId, other.symbol)).json()).mode,
      'live',
    );
    const earlyClose = randomUUID();
    await close(earlyClose, other.symbol);
    assert.equal(
      await subscriptions.retainView('viewer', earlyClose, other.symbol),
      false,
    );
    assert.deepEqual(await state.watchlist('viewer', 'tqsdk'), []);
  },
);
