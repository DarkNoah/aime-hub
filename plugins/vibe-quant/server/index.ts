import { Hono } from 'hono';
import { z } from 'zod';
import type {
  PluginContext,
  PluginHttpEnv,
  PluginServer,
} from '@app/plugin-sdk/server';
import type { SyncStatus } from '../shared.js';
import { parseConfig, type QuantConfig } from './config.js';
import { MarketStore } from './clickhouse.js';
import { StateStore } from './state-store.js';
import { migrateState } from './migrate-state.js';
import { SyncWorker } from './worker.js';
import { searchTerms, supports } from './symbols.js';
import { StrategyFeed } from './sdk/feed.js';
import { StrategySubscriptions } from './sdk/subscriptions.js';
import { strategyDataRoutes } from './sdk/routes.js';
import { StrategyStore } from './strategies/store.js';
import { migrateStrategies } from './strategies/migrate.js';
import { strategyRoutes } from './strategies/routes.js';
import { BacktestWorker } from './strategies/runner.js';
import { marketBarsQuery, readMarketBars } from './market-bars.js';
import { createQuantMastra } from '../mastra/index.js';
import { NewsStore } from './news/store.js';
import { NewsWorker } from './news/worker.js';
import { newsRoutes } from './news/routes.js';
import { readVolumeProfile, volumeProfileQuery } from './volume-profile.js';
import { TradeService } from './trades/service.js';
import { MonitorStore } from './signals/store.js';
import { SignalWorker } from './signals/worker.js';
import { signalRoutes } from './signals/routes.js';

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
  let feed: StrategyFeed;
  let subscriptions: StrategySubscriptions;
  let records: StrategyStore;
  let backtests: BacktestWorker | undefined;
  let news: NewsStore;
  let newsWorker: NewsWorker | undefined;
  let trades: TradeService;
  let monitors: MonitorStore;
  let signals: SignalWorker | undefined;
  const api = new Hono<PluginHttpEnv>();
  api.route(
    '/strategies',
    signalRoutes(() => ({
      records,
      monitors,
      state,
      config,
      wake: () => signals?.wake(true),
      wakeBacktests: () => backtests?.wake(),
    })),
  );
  api.route(
    '/news',
    newsRoutes(() => ({ store: news, config })),
  );
  api.route(
    '/strategies',
    strategyRoutes(
      context,
      () => records,
      () => ({
        config,
        state,
        store,
        trades,
        wake: () => backtests?.wake(),
      }),
    ),
  );
  api.onError((_error, c) =>
    c.json({ code: 'MARKET_SERVICE_UNAVAILABLE' }, 503),
  );
  const sdkApi = strategyDataRoutes(() => ({
    config,
    store,
    state,
    feed,
    subscriptions,
    status: () => worker!.getStatus(),
  }));
  api.route('/sdk', sdkApi);
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
    const query = marketBarsQuery.safeParse(c.req.query());
    if (!symbol.success || !query.success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const owned = await state.owns(c.get('userId'), symbol.data);
    if (!owned) return c.json({ code: 'NOT_IN_WATCHLIST' }, 404);
    return c.json(
      await readMarketBars(store, config.engine, symbol.data, query.data),
    );
  });
  api.get('/volume-profile', async (c) => {
    const symbol = symbolSchema.safeParse(c.req.query('symbol'));
    const query = volumeProfileQuery.safeParse(c.req.query());
    if (!symbol.success || !query.success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    if (!(await state.owns(c.get('userId'), symbol.data)))
      return c.json({ code: 'NOT_IN_WATCHLIST' }, 404);
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
    await signals?.stop();
    signals = undefined;
    await trades?.stop();
    await newsWorker?.stop();
    newsWorker = undefined;
    await backtests?.stop();
    backtests = undefined;
    await worker?.stop();
    worker = undefined;
  };
  return {
    api,
    ...createQuantMastra(context, () => ({
      records,
      state,
      news,
      config,
      wake: () => backtests?.wake(),
    })),
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
      trades = new TradeService(config);
      await trades.initialize();
      records = new StrategyStore(config);
      await records.initialize();
      await migrateStrategies(context.database, records);
      monitors = new MonitorStore(config);
      await monitors.initialize();
      news = new NewsStore(config);
      await news.initialize();
      if (config.newsEnabled && !context.web)
        throw new Error('资讯采集需要宿主 web_fetch 服务，请升级宿主后重试');
      feed = new StrategyFeed();
      subscriptions = new StrategySubscriptions(config);
      worker = new SyncWorker(
        context,
        config,
        store,
        state,
        undefined,
        (batch) => feed.publish(batch),
      );
      worker.start();
      signals = new SignalWorker(
        context,
        monitors,
        records,
        async (owner, path, init) => {
          // In-process transport reuses the SDK route validation; no session cookies or public bypass.
          const bridge = new Hono<PluginHttpEnv>();
          bridge.use('*', async (c, next) => {
            c.set('userId', owner);
            c.set('isAdmin', true);
            await next();
          });
          bridge.route('/', sdkApi);
          return bridge.request(`http://monitor${path}`, init);
        },
        () => worker!.getStatus(),
      );
      signals.start();
      backtests = new BacktestWorker(context, records, {
        config,
        store,
        state,
      });
      backtests.start();
      if (config.newsEnabled && context.web) {
        newsWorker = new NewsWorker(config, news, context.web);
        newsWorker.start();
      }
    },
    onDisable: stop,
    dispose: stop,
  };
}
