import { Hono } from 'hono';
import { z } from 'zod';
import type {
  PluginContext,
  PluginHttpEnv,
  PluginServer,
} from '@app/plugin-sdk/server';
import { DURATIONS, type SyncStatus } from '../shared.js';
import { parseConfig, type QuantConfig } from './config.js';
import { MarketStore } from './clickhouse.js';
import { StateStore } from './state-store.js';
import { migrateState } from './migrate-state.js';
import { SyncWorker } from './worker.js';
import { searchTerms, supports } from './symbols.js';

const symbolSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.@-]+$/);
export default function createServer(context: PluginContext): PluginServer {
  let config: QuantConfig;
  let store: MarketStore;
  let state: StateStore;
  let worker: SyncWorker | undefined;
  const api = new Hono<PluginHttpEnv>();
  api.onError((_error, c) =>
    c.json({ code: 'MARKET_SERVICE_UNAVAILABLE' }, 503),
  );
  const watchlist = (userId: string) => state.watchlist(userId, config.engine);
  api.get('/instruments', async (c) => {
    const { continuous } = searchTerms(c.req.query('q') ?? '');
    const kind = continuous ? 'continuous' : (c.req.query('kind') ?? 'all');
    if (!['all', 'stock', 'future', 'option', 'continuous'].includes(kind))
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(
      await state.search(config.engine, c.req.query('q') ?? '', kind),
    );
  });
  api.get('/watchlist', async (c) => c.json(await watchlist(c.get('userId'))));
  api.post('/watchlist', async (c) => {
    const input = z
      .strictObject({ symbol: symbolSchema })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const instrument = await state.instrument(config.engine, input.data.symbol);
    if (!instrument || !supports(config.engine, instrument))
      return c.json({ code: 'UNSUPPORTED_INSTRUMENT' }, 400);
    const result = await state.setWatch(
      c.get('userId'),
      input.data.symbol,
      true,
      'add',
    );
    return result === 'ok'
      ? c.json({ ...instrument, enabled: true }, 201)
      : c.json({ code: 'SUBSCRIPTION_LIMIT' }, 409);
  });
  api.patch('/watchlist/:symbol', async (c) => {
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
    const symbol = symbolSchema.safeParse(c.req.param('symbol'));
    if (!symbol.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    await state.setWatch(c.get('userId'), symbol.data, false, 'delete');
    return c.json({ deleted: true });
  });
  api.get('/snapshot', async (c) => {
    const list = await watchlist(c.get('userId'));
    const local = worker!.getStatus();
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
    const symbol = symbolSchema.safeParse(c.req.query('symbol'));
    const duration = Number(c.req.query('duration') ?? 60);
    const timestamp = (name: string) =>
      c.req.query(name) === undefined ? undefined : Number(c.req.query(name));
    const before = timestamp('before');
    const after = timestamp('after');
    const around = timestamp('around');
    const limit = Number(c.req.query('limit') ?? 1000);
    if (
      !symbol.success ||
      !DURATIONS.some((d) => d === duration) ||
      [before, after, around].some(
        (value) =>
          value !== undefined && (!Number.isSafeInteger(value) || value <= 0),
      ) ||
      [before, after, around].filter((value) => value !== undefined).length >
        1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const owned = await state.owns(c.get('userId'), symbol.data);
    if (!owned) return c.json({ code: 'NOT_IN_WATCHLIST' }, 404);
    return c.json(
      around === undefined
        ? await store.bars(config.engine, symbol.data, duration, {
            before,
            after,
            limit,
          })
        : await store.barsAround(config.engine, symbol.data, duration, around),
    );
  });
  api.get('/ticks/validation', async (c) => {
    const symbol = symbolSchema.safeParse(c.req.query('symbol'));
    const day = z.iso.date().safeParse(c.req.query('tradingDay'));
    if (!symbol.success || !day.success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    if (!(await state.owns(c.get('userId'), symbol.data)))
      return c.json({ code: 'NOT_IN_WATCHLIST' }, 404);
    if (config.engine !== 'tqsdk')
      return c.json({ code: 'TICK_ENGINE_UNSUPPORTED' }, 400);
    let sourceSymbol = symbol.data;
    if (sourceSymbol.startsWith('KQ.m@')) {
      const [quote] = await store.quotes(config.engine, [sourceSymbol]);
      if (!quote?.underlying)
        return c.json({ code: 'TICK_UNDERLYING_UNAVAILABLE' }, 409);
      sourceSymbol = quote.underlying;
    }
    return c.json({
      requestedSymbol: symbol.data,
      ...(await store.validateTickVolumes(
        config.engine,
        sourceSymbol,
        day.data,
      )),
    });
  });
  const stop = async () => {
    await worker?.stop();
    worker = undefined;
  };
  return {
    api,
    async onEnable({ config: values }) {
      config = parseConfig(values);
      state = new StateStore(config);
      await state.initialize();
      await migrateState(context, state);
      const count = (await state.subscriptions(config.engine)).length;
      if (count > config.maxSubscriptions)
        throw new Error(
          '当前启用的自选数量超过订阅上限，请先提高上限或暂停多余订阅',
        );
      store = new MarketStore(config);
      await store.initialize();
      worker = new SyncWorker(context, config, store, state);
      worker.start();
    },
    onDisable: stop,
    dispose: stop,
  };
}
