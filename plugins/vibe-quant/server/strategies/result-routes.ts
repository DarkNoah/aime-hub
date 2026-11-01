import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { z } from 'zod';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { StrategyStore } from './store.js';
import { StrategyError } from './schema.js';
import {
  BacktestViewReader,
  selectedTradeRisk,
  tradePage,
} from './result-view.js';

export function backtestResultRoutes(getRecords: () => StrategyStore) {
  const api = new Hono<PluginHttpEnv>();
  const readers = new WeakMap<StrategyStore, BacktestViewReader>();
  api.use('/runs/:runId/view*', compress());
  async function read(actor: string, id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new StrategyError('RUN_NOT_FOUND', 404);
    const records = getRecords();
    // Always check current access/deletion before consulting the cache.
    const run = await records.run(actor, id);
    let reader = readers.get(records);
    if (!reader) {
      reader = new BacktestViewReader();
      readers.set(records, reader);
    }
    return reader.read(records, run);
  }
  api.get('/runs/:runId/view', async (c) => {
    const model = await read(c.get('userId'), c.req.param('runId'));
    c.header('Cache-Control', 'private, no-store');
    return c.json(model?.view ?? { result: null, manifest: null });
  });
  api.get('/runs/:runId/view/trades', async (c) => {
    const page = z.coerce
      .number()
      .int()
      .nonnegative()
      .max(1_000_000)
      .safeParse(c.req.query('page') ?? '0');
    if (!page.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const model = await read(c.get('userId'), c.req.param('runId'));
    c.header('Cache-Control', 'private, no-store');
    return c.json(tradePage(model?.trades ?? [], page.data));
  });
  api.get('/runs/:runId/view/logs', async (c) => {
    const model = await read(c.get('userId'), c.req.param('runId'));
    if (!model) throw new StrategyError('RUN_NOT_FOUND', 404);
    c.header('Cache-Control', 'private, no-store');
    return c.json(model.logs);
  });
  api.get('/runs/:runId/view/risk', async (c) => {
    const model = await read(c.get('userId'), c.req.param('runId'));
    const trade = model?.trades.find(
      (item) => item.id === c.req.query('trade'),
    );
    if (!model || !trade) throw new StrategyError('NOT_FOUND', 404);
    c.header('Cache-Control', 'private, no-store');
    return c.json(selectedTradeRisk(model, trade));
  });
  return api;
}
