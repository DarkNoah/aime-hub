import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { SyncStatus } from '../shared.js';
import type { QuantConfig } from './config.js';
import type { StateStore } from './state-store.js';
import type { MarketStore } from './clickhouse.js';
import type { StrategySubscriptions } from './sdk/subscriptions.js';
import type { MonitorStore } from './signals/store.js';
import type { TradeReader } from './trades/service.js';
import { supports, symbolSchema } from './symbols.js';
import { marketBarsQuery, readMarketBars } from './market-bars.js';
import { readVolumeProfile, volumeProfileQuery } from './volume-profile.js';
import { readMonitorMarketBars } from './signals/market.js';
import { StrategyError } from './strategies/schema.js';

export function marketViewRoutes(
  get: () => {
    config: QuantConfig;
    state: StateStore;
    store: MarketStore;
    subscriptions: StrategySubscriptions;
    monitors: MonitorStore;
    trades: TradeReader;
    status: () => SyncStatus;
  },
) {
  const api = new Hono<PluginHttpEnv>();
  api.post('/market-view/:id', async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    const input = z
      .strictObject({ symbol: symbolSchema })
      .safeParse(await c.req.json().catch(() => null));
    if (!id.success || !input.success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { config, state, store, subscriptions } = get();
    const { symbol } = input.data;
    const instrument = await state.viewInstrument(config.engine, symbol);
    if (!instrument) return c.json({ code: 'INSTRUMENT_NOT_FOUND' }, 404);
    const live = supports(config.engine, instrument);
    if (
      live &&
      (await subscriptions.retainView(c.get('userId'), id.data, symbol))
    )
      return c.json({ instrument, mode: 'live' });
    const availableDurations = await store.storedDurations(
      config.engine,
      symbol,
    );
    return c.json({
      instrument,
      mode: live ? 'limit' : 'history',
      availableDurations,
    });
  });
  api.delete('/market-view/:id', async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    const symbol = symbolSchema.safeParse(c.req.query('symbol'));
    if (!id.success || !symbol.success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    await get().subscriptions.releaseView(
      c.get('userId'),
      id.data,
      symbol.data,
    );
    return c.json({ closed: true });
  });
  api.get('/snapshot', async (c) => {
    const { config, state, store, status: currentStatus } = get();
    const selected = symbolSchema.optional().safeParse(c.req.query('symbol'));
    if (!selected.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const list = await state.watchlist(c.get('userId'), config.engine);
    const local = currentStatus();
    const status: SyncStatus = config.clickhouseReadOnly
      ? local
      : ((await state.writerStatus(config.engine)) ?? local);
    if (
      status.updatedAt &&
      Date.now() - new Date(status.updatedAt).getTime() >
        Math.max(30000, config.flushSeconds * 3000)
    ) {
      status.state = 'error';
      status.message = '同步心跳已超时，正在恢复连接';
    }
    const symbols = list.map((item) => item.symbol);
    if (selected.data && !symbols.includes(selected.data)) {
      if (!(await state.viewInstrument(config.engine, selected.data)))
        return c.json({ code: 'INSTRUMENT_NOT_FOUND' }, 404);
      symbols.push(selected.data);
    }
    const [quotes, orderBooks] = await Promise.all([
      store.quotes(config.engine, symbols),
      store.orderBooks(config.engine, symbols),
    ]);
    if (status.tickValidation) {
      const visible = new Set([
        ...symbols,
        ...quotes.map((quote) => quote.underlying).filter(Boolean),
      ]);
      status.tickValidation = status.tickValidation.filter((item) =>
        visible.has(item.symbol),
      );
    }
    return c.json({ status, quotes, orderBooks });
  });
  api.get('/bars', async (c) => {
    const { config, store, state, monitors } = get();
    const symbol = symbolSchema.safeParse(c.req.query('symbol'));
    const query = marketBarsQuery.safeParse(c.req.query());
    if (!symbol.success || !query.success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const monitorId = c.req.query('monitor');
    if (monitorId) {
      try {
        return c.json(
          await readMonitorMarketBars(
            monitors,
            store,
            c.get('userId'),
            monitorId,
            symbol.data,
            query.data,
          ),
        );
      } catch (error) {
        if (error instanceof StrategyError)
          return c.json({ code: error.code }, error.status);
        throw error;
      }
    }
    if (!(await state.viewInstrument(config.engine, symbol.data)))
      return c.json({ code: 'INSTRUMENT_NOT_FOUND' }, 404);
    return c.json(
      await readMarketBars(store, config.engine, symbol.data, query.data),
    );
  });
  api.get('/volume-profile', async (c) => {
    const { config, store, state, trades } = get();
    const symbol = symbolSchema.safeParse(c.req.query('symbol'));
    const query = volumeProfileQuery.safeParse(c.req.query());
    if (!symbol.success || !query.success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    if (!(await state.viewInstrument(config.engine, symbol.data)))
      return c.json({ code: 'INSTRUMENT_NOT_FOUND' }, 404);
    return c.json(
      await readVolumeProfile(
        store,
        config.engine,
        symbol.data,
        query.data,
        trades,
        c.req.raw.signal,
      ),
    );
  });
  return api;
}
