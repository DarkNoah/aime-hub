import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import { DURATIONS, type SyncStatus } from '../../shared.js';
import type { QuantConfig } from '../config.js';
import type { MarketStore } from '../clickhouse.js';
import type { StateStore } from '../state-store.js';
import { supports } from '../symbols.js';
import type { StrategyFeed } from './feed.js';
import type { StrategySubscriptions } from './subscriptions.js';

type Dependencies = {
  config: QuantConfig;
  store: MarketStore;
  state: StateStore;
  feed: StrategyFeed;
  subscriptions: StrategySubscriptions;
  status: () => SyncStatus;
};
const symbolSchema = z.string().regex(/^[A-Za-z0-9_.@-]{1,100}$/);

export function strategyDataRoutes(get: () => Dependencies) {
  const api = new Hono<PluginHttpEnv>();
  const sessions = new Map<
    string,
    { owner: string; symbols: Set<string>; expires: number }
  >();
  const pending = new Map<string, number>();
  const prune = () => {
    for (const [id, session] of sessions)
      if (session.expires < Date.now()) sessions.delete(id);
  };
  api.get('/instruments/:symbol', async (c) => {
    const parsed = symbolSchema.safeParse(c.req.param('symbol'));
    if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { state, config } = get();
    const item = await state.instrument(config.engine, parsed.data);
    return item ? c.json(item) : c.json({ code: 'INSTRUMENT_NOT_FOUND' }, 404);
  });
  api.get('/history', async (c) => {
    const parsed = z
      .object({
        symbol: symbolSchema,
        duration: z.coerce
          .number()
          .refine((value) => DURATIONS.some((d) => d === value)),
        after: z.coerce.number().finite().nonnegative(),
        before: z.coerce.number().finite().positive(),
        limit: z.coerce.number().int().min(1).max(1000).default(1000),
      })
      .safeParse(c.req.query());
    if (!parsed.success || parsed.data.after >= parsed.data.before)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { config, state, store } = get();
    const { symbol, duration, after, before, limit } = parsed.data;
    const item = await state.instrument(config.engine, symbol);
    if (!item || item.kind === 'option')
      return c.json({ code: 'UNSUPPORTED_INSTRUMENT' }, 400);
    const bars = (
      await store.bars(config.engine, symbol, duration, {
        after: Math.floor(after),
        before: Math.ceil(before),
        limit,
      })
    ).filter((bar) => bar.time > after && bar.time < before);
    return c.json({
      engine: config.engine,
      bars,
      next: bars.length === limit ? bars.at(-1)!.time : null,
      dataPolicy: 'latest-corrected; freeze returned data before backtesting',
    });
  });
  api.get('/contracts', async (c) => {
    const parsed = z
      .object({
        symbol: symbolSchema,
        from: z.coerce.number().finite().nonnegative(),
        to: z.coerce.number().finite().positive(),
        after: z.coerce.number().finite().optional(),
      })
      .safeParse(c.req.query());
    if (!parsed.success || parsed.data.from >= parsed.data.to)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { state, config, store } = get();
    const { symbol, from, to, after } = parsed.data;
    const item = await state.instrument(config.engine, symbol);
    if (item?.kind !== 'continuous' || !symbol.startsWith('KQ.m@'))
      return c.json({ code: 'UNSUPPORTED_INSTRUMENT' }, 400);
    const rows = await store.rows<{ time: number; underlying: string }>(
      `SELECT time, underlying FROM ${store.table('quotes')} FINAL
       WHERE engine = {engine:String} AND symbol = {symbol:String}
         AND time > {after:Float64} AND time < {to:Float64} ORDER BY time LIMIT 1000`,
      {
        engine: config.engine,
        symbol,
        after: String(after ?? from),
        to: String(to),
      },
    );
    const initial =
      after === undefined
        ? await store.rows<{ time: number; underlying: string }>(
            `SELECT time, underlying FROM ${store.table('quotes')} FINAL
       WHERE engine = {engine:String} AND symbol = {symbol:String} AND time <= {from:Float64}
       ORDER BY time DESC LIMIT 1`,
            { engine: config.engine, symbol, from: String(from) },
          )
        : [];
    return c.json({
      mappings: [...initial, ...rows],
      next: rows.length === 1000 ? rows.at(-1)!.time : null,
      dataPolicy:
        'observed mappings; missing or empty mappings are not inferred from the current contract',
    });
  });
  api.post('/sessions', async (c) => {
    prune();
    const parsed = z
      .object({ symbols: z.array(symbolSchema).min(1).max(100) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { config, state, store, feed, subscriptions, status } = get();
    if (status().state === 'standby')
      return c.json({ code: 'CONNECT_TO_ACTIVE_COLLECTOR' }, 409);
    const owner = c.get('userId');
    if (
      [...sessions.values()].filter((s) => s.owner === owner).length +
        (pending.get(owner) ?? 0) >=
      8
    )
      return c.json({ code: 'SDK_SESSION_LIMIT' }, 429);
    pending.set(owner, (pending.get(owner) ?? 0) + 1);
    try {
      const symbols = [...new Set(parsed.data.symbols)];
      for (const symbol of symbols) {
        const item = await state.instrument(config.engine, symbol);
        if (!item || item.kind === 'option' || !supports(config.engine, item))
          return c.json({ code: 'UNSUPPORTED_INSTRUMENT', symbol }, 400);
      }
      const cursor = feed.cursor;
      const serverTime = Date.now() / 1000;
      const initialQuotes = await store.quotes(config.engine, symbols);
      const retained = new Set(symbols);
      for (const quote of initialQuotes) {
        if (!quote.symbol.startsWith('KQ.m@') || !quote.underlying) continue;
        const contract = await state.instrument(
          config.engine,
          quote.underlying,
        );
        if (contract?.kind === 'future' && !contract.expired)
          retained.add(contract.symbol);
      }
      const id = randomUUID();
      if (!(await subscriptions.retain(owner, id, [...retained])))
        return c.json({ code: 'SUBSCRIPTION_LIMIT' }, 409);
      sessions.set(id, {
        owner,
        symbols: retained,
        expires: Date.now() + 120_000,
      });
      return c.json(
        {
          id,
          cursor,
          engine: config.engine,
          expiresIn: 120,
          serverTime,
          initialQuotes,
        },
        201,
      );
    } finally {
      const count = (pending.get(owner) ?? 1) - 1;
      if (count) pending.set(owner, count);
      else pending.delete(owner);
    }
  });
  api.get('/sessions/:id/events', async (c) => {
    prune();
    const session = sessions.get(c.req.param('id'));
    if (!session || session.owner !== c.get('userId'))
      return c.json({ code: 'SDK_SESSION_NOT_FOUND' }, 404);
    const { feed, subscriptions, status } = get();
    if (status().state === 'standby')
      return c.json({ code: 'CONNECT_TO_ACTIVE_COLLECTOR' }, 409);
    const cursor = c.req.query('cursor') ?? '';
    const symbols = new Set(session.symbols);
    const result = feed.read(cursor, symbols);
    if (!result)
      return c.json(
        {
          code: 'SDK_EVENT_GAP',
          message: '事件游标已失效，请重新预热后恢复策略',
        },
        409,
      );
    if (
      !(await subscriptions.retain(session.owner, c.req.param('id'), [
        ...symbols,
      ]))
    )
      return c.json({ code: 'SUBSCRIPTION_LIMIT' }, 409);
    session.symbols = symbols;
    session.expires = Date.now() + 120_000;
    return c.json({ ...result, status: status() });
  });
  api.delete('/sessions/:id', async (c) => {
    const session = sessions.get(c.req.param('id'));
    if (!session || session.owner !== c.get('userId'))
      return c.json({ code: 'SDK_SESSION_NOT_FOUND' }, 404);
    await get().subscriptions.release(session.owner, c.req.param('id'));
    sessions.delete(c.req.param('id'));
    return c.json({ closed: true });
  });
  return api;
}
