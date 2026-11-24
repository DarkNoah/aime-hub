import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { QuantConfig } from './config.js';
import type { StateStore } from './state-store.js';
import type { MarketStore } from './clickhouse.js';
import { searchTerms, supports, symbolSchema } from './symbols.js';

export function watchlistRoutes(
  get: () => {
    config: Pick<QuantConfig, 'engine'>;
    state: Pick<
      StateStore,
      | 'search'
      | 'searchPage'
      | 'watchlist'
      | 'instrument'
      | 'viewInstrument'
      | 'setWatch'
    >;
    store: Pick<MarketStore, 'storedSymbols'>;
  },
) {
  const api = new Hono<PluginHttpEnv>();
  api.get('/instruments', async (c) => {
    const { config, state, store } = get();
    const query = c.req.query('q') ?? '';
    const kind = searchTerms(query).continuous
      ? 'continuous'
      : (c.req.query('kind') ?? 'all');
    if (!['all', 'stock', 'future', 'option', 'continuous'].includes(kind))
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    if (c.req.query('paged') !== '1')
      return c.json(await state.search(config.engine, query, kind));
    const token = c.req.query('cursor');
    const match = token?.match(/^([012]):([A-Za-z0-9_.@-]{1,100})$/);
    if (token && !match) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const page = await state.searchPage(
      config.engine,
      query,
      kind,
      match ? { rank: Number(match[1]), symbol: match[2] } : undefined,
      true,
    );
    const saved = await store.storedSymbols(
      config.engine,
      page.items.map((item) => item.symbol),
    );
    return c.json({
      items: page.items.map((item) => ({
        ...item,
        localHistory: saved.has(item.symbol),
      })),
      nextCursor: page.nextCursor,
    });
  });
  api.get('/watchlist', async (c) => {
    const { state, config } = get();
    return c.json(await state.watchlist(c.get('userId'), config.engine));
  });
  api.post('/watchlist', async (c) => {
    const { config, state, store } = get();
    const input = z
      .strictObject({ symbol: symbolSchema })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { symbol } = input.data;
    const instrument = await state.viewInstrument(config.engine, symbol);
    if (!instrument) return c.json({ code: 'UNSUPPORTED_INSTRUMENT' }, 400);
    const owner = c.get('userId');
    const live = supports(config.engine, instrument);
    if (live && (await state.setWatch(owner, symbol, true, 'add')) === 'ok')
      return c.json({ ...instrument, enabled: true }, 201);

    // A stored contract can be viewed even at the live quota or after expiry.
    if (
      instrument.localHistory ||
      (await store.storedSymbols(config.engine, [symbol])).has(symbol)
    ) {
      await state.setWatch(owner, symbol, false, 'add');
      return c.json({ ...instrument, enabled: false }, 201);
    }
    return live
      ? c.json({ code: 'SUBSCRIPTION_LIMIT' }, 409)
      : c.json({ code: 'UNSUPPORTED_INSTRUMENT' }, 400);
  });
  api.patch('/watchlist/:symbol', async (c) => {
    const { config, state } = get();
    const symbol = symbolSchema.safeParse(c.req.param('symbol'));
    const input = z
      .strictObject({ enabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!symbol.success || !input.success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    if (input.data.enabled) {
      const instrument = await state.instrument(config.engine, symbol.data);
      if (!instrument || !supports(config.engine, instrument))
        return c.json({ code: 'UNSUPPORTED_INSTRUMENT' }, 400);
    }
    const result = await state.setWatch(
      c.get('userId'),
      symbol.data,
      input.data.enabled,
      'update',
    );
    if (result === 'limit') return c.json({ code: 'SUBSCRIPTION_LIMIT' }, 409);
    if (result === 'missing') return c.json({ code: 'NOT_FOUND' }, 404);
    return c.json({ symbol: symbol.data, enabled: input.data.enabled });
  });
  api.delete('/watchlist/:symbol', async (c) => {
    const { state } = get();
    const symbol = symbolSchema.safeParse(c.req.param('symbol'));
    if (!symbol.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    await state.setWatch(c.get('userId'), symbol.data, false, 'delete');
    return c.json({ deleted: true });
  });
  return api;
}
