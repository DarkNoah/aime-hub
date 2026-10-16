import { Hono } from 'hono';
import { z } from 'zod';
import type {
  PluginContext,
  PluginHttpEnv,
  PluginServer,
} from '@app/plugin-sdk/server';
import { DURATIONS, type Instrument, type SyncStatus } from '../shared.js';
import { parseConfig, type QuantConfig } from './config.js';
import { MarketStore } from './clickhouse.js';
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
  let worker: SyncWorker | undefined;
  const api = new Hono<PluginHttpEnv>();
  api.onError((_error, c) =>
    c.json({ code: 'MARKET_SERVICE_UNAVAILABLE' }, 503),
  );
  const watchlist = async (userId: string) => {
    const rows: { metadata: Instrument; enabled: boolean }[] =
      await context.database.query(
        `SELECT COALESCE(i.metadata, (
        SELECT metadata FROM plugin_vibe_quant_instruments WHERE symbol = w.symbol ORDER BY updated_at DESC LIMIT 1
      )) AS metadata, w.enabled FROM plugin_vibe_quant_watchlist w
      LEFT JOIN plugin_vibe_quant_instruments i ON i.symbol = w.symbol AND i.engine = $2
      WHERE w.user_id = $1 ORDER BY w.created_at, w.symbol`,
        [userId, config.engine],
      );
    return rows
      .filter((row) => row.metadata)
      .map((row) => ({ ...row.metadata, enabled: row.enabled }));
  };
  api.get('/instruments', async (c) => {
    const { term, continuous } = searchTerms(c.req.query('q') ?? '');
    const kind = continuous ? 'continuous' : (c.req.query('kind') ?? 'all');
    if (!['all', 'stock', 'future', 'option', 'continuous'].includes(kind))
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const rows: { metadata: Instrument }[] = await context.database.query(
      `SELECT metadata FROM plugin_vibe_quant_instruments
      WHERE engine = $1 AND ($2 = 'all' OR metadata->>'kind' = $2)
      AND (symbol ILIKE $3 OR metadata->>'name' ILIKE $3)
      AND NOT COALESCE((metadata->>'expired')::boolean, false)
      ORDER BY (split_part(symbol, '.', 2) ILIKE $4) DESC, symbol LIMIT 60`,
      [config.engine, kind, `%${term}%`, term],
    );
    return c.json(rows.map((row) => row.metadata));
  });
  api.get('/watchlist', async (c) => c.json(await watchlist(c.get('userId'))));
  api.post('/watchlist', async (c) => {
    const input = z
      .strictObject({ symbol: symbolSchema })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const [row]: { metadata: Instrument }[] = await context.database.query(
      'SELECT metadata FROM plugin_vibe_quant_instruments WHERE engine = $1 AND symbol = $2',
      [config.engine, input.data.symbol],
    );
    if (!row || !supports(config.engine, row.metadata))
      return c.json({ code: 'UNSUPPORTED_INSTRUMENT' }, 400);
    const result = await context.database.transaction(async (manager) => {
      // One lock serializes subscription-cap checks across all users and instances.
      await manager.query('SELECT pg_advisory_xact_lock(179210002)');
      const [{ count }]: { count: number }[] = await manager.query(
        `SELECT count(DISTINCT w.symbol)::int AS count FROM plugin_vibe_quant_watchlist w
         JOIN plugin_vibe_quant_instruments i ON i.symbol = w.symbol AND i.engine = $2
         WHERE w.enabled AND w.symbol <> $1 AND NOT COALESCE((i.metadata->>'expired')::boolean, false)`,
        [input.data.symbol, config.engine],
      );
      if (count >= config.maxSubscriptions) return false;
      await manager.query(
        `INSERT INTO plugin_vibe_quant_watchlist (user_id, symbol) VALUES ($1, $2)
        ON CONFLICT (user_id, symbol) DO UPDATE SET enabled = true`,
        [c.get('userId'), input.data.symbol],
      );
      return true;
    });
    return result
      ? c.json({ ...row.metadata, enabled: true }, 201)
      : c.json({ code: 'SUBSCRIPTION_LIMIT' }, 409);
  });
  api.patch('/watchlist/:symbol', async (c) => {
    const symbol = symbolSchema.safeParse(c.req.param('symbol'));
    const input = z
      .strictObject({ enabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!symbol.success || !input.success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const result = await context.database.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(179210002)');
      if (input.data.enabled) {
        const [instrument] = await manager.query(
          'SELECT metadata FROM plugin_vibe_quant_instruments WHERE engine = $1 AND symbol = $2',
          [config.engine, symbol.data],
        );
        if (!instrument || !supports(config.engine, instrument.metadata))
          return 'unsupported';
        const [{ count }] = await manager.query(
          `SELECT count(DISTINCT w.symbol)::int AS count FROM plugin_vibe_quant_watchlist w
           JOIN plugin_vibe_quant_instruments i ON i.symbol = w.symbol AND i.engine = $2
           WHERE w.enabled AND w.symbol <> $1 AND NOT COALESCE((i.metadata->>'expired')::boolean, false)`,
          [symbol.data, config.engine],
        );
        if (count >= config.maxSubscriptions) return 'limit';
      }
      const rows = await manager.query(
        'UPDATE plugin_vibe_quant_watchlist SET enabled = $3 WHERE user_id = $1 AND symbol = $2 RETURNING symbol',
        [c.get('userId'), symbol.data, input.data.enabled],
      );
      return rows[1] ? 'ok' : 'missing';
    });
    if (result === 'unsupported')
      return c.json({ code: 'UNSUPPORTED_INSTRUMENT' }, 400);
    if (result === 'limit') return c.json({ code: 'SUBSCRIPTION_LIMIT' }, 409);
    if (result === 'missing') return c.json({ code: 'NOT_FOUND' }, 404);
    return c.json({ symbol: symbol.data, enabled: input.data.enabled });
  });
  api.delete('/watchlist/:symbol', async (c) => {
    const symbol = symbolSchema.safeParse(c.req.param('symbol'));
    if (!symbol.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    await context.database.query(
      'DELETE FROM plugin_vibe_quant_watchlist WHERE user_id = $1 AND symbol = $2',
      [c.get('userId'), symbol.data],
    );
    return c.json({ deleted: true });
  });
  api.get('/snapshot', async (c) => {
    const list = await watchlist(c.get('userId'));
    const [saved]: { payload: SyncStatus; updated_at: Date }[] =
      await context.database.query(
        'SELECT payload, updated_at FROM plugin_vibe_quant_status WHERE id = 1',
      );
    const status: SyncStatus =
      saved?.payload.engine === config.engine
        ? saved.payload
        : {
            engine: config.engine,
            state: 'starting',
            message: '等待同步进程就绪',
            updatedAt: null,
            lastWriteAt: null,
            subscriptions: 0,
            active: 0,
            catalogCount: 0,
            beforeOpenMinutes: config.beforeOpenMinutes,
            afterCloseMinutes: config.afterCloseMinutes,
          };
    if (
      saved &&
      Date.now() - new Date(saved.updated_at).getTime() >
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
    return c.json({ status, quotes, orderBooks });
  });
  api.get('/bars', async (c) => {
    const symbol = symbolSchema.safeParse(c.req.query('symbol'));
    const duration = Number(c.req.query('duration') ?? 60);
    const before = c.req.query('before')
      ? Number(c.req.query('before'))
      : undefined;
    if (
      !symbol.success ||
      !DURATIONS.some((d) => d === duration) ||
      (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))
    )
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const [owned] = await context.database.query(
      'SELECT 1 FROM plugin_vibe_quant_watchlist WHERE user_id = $1 AND symbol = $2',
      [c.get('userId'), symbol.data],
    );
    if (!owned) return c.json({ code: 'NOT_IN_WATCHLIST' }, 404);
    return c.json(
      await store.bars(config.engine, symbol.data, duration, before),
    );
  });
  const stop = async () => {
    await worker?.stop();
    worker = undefined;
  };
  return {
    api,
    async onEnable({ config: values }) {
      config = parseConfig(values);
      const [{ count }] = await context.database.query(
        `SELECT count(DISTINCT w.symbol)::int AS count FROM plugin_vibe_quant_watchlist w
        JOIN plugin_vibe_quant_instruments i ON i.symbol = w.symbol AND i.engine = $1
        WHERE w.enabled AND NOT COALESCE((i.metadata->>'expired')::boolean, false)`,
        [config.engine],
      );
      if (count > config.maxSubscriptions)
        throw new Error(
          '当前启用的自选数量超过订阅上限，请先提高上限或暂停多余订阅',
        );
      store = new MarketStore(config);
      await store.initialize();
      worker = new SyncWorker(context, config, store);
      worker.start();
    },
    onDisable: stop,
    dispose: stop,
  };
}
