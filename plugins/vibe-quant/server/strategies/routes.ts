import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import type { BacktestResult } from '../../strategy-types.js';
import type { QuantConfig } from '../config.js';
import type { StateStore } from '../state-store.js';
import type { MarketStore } from '../clickhouse.js';
import { marketBarsQuery, readMarketBars } from '../market-bars.js';
import { readVolumeProfile, volumeProfileQuery } from '../volume-profile.js';
import type { TradeReader } from '../trades/service.js';
import { StrategyStore } from './store.js';
import { backtestSchema, StrategyError, strategySchema } from './schema.js';
import { enqueueBacktest } from './enqueue.js';
import {
  replayQuerySchema,
  replayWindow,
  type ReplayDataset,
} from './replay.js';

function readId(id: string) {
  if (!z.uuid().safeParse(id).success)
    throw new StrategyError('NOT_FOUND', 404);
  return id;
}

export function strategyRoutes(
  context: PluginContext,
  getRecords: () => StrategyStore,
  get: () => {
    config: QuantConfig;
    state: StateStore;
    store: MarketStore;
    trades: TradeReader;
    wake: () => void;
  },
) {
  const api = new Hono<PluginHttpEnv>();
  api.onError((error, c) => {
    if (error instanceof StrategyError)
      return c.json({ code: error.code }, error.status);
    console.error(
      '[vibe-quant strategies]',
      error instanceof Error ? error.name : 'UnknownError',
    );
    return c.json({ code: 'STRATEGY_SERVICE_UNAVAILABLE' }, 503);
  });
  api.get('/template', async (c) =>
    c.json({
      canRun: c.get('isAdmin'),
      runtime: 'plugin-venv',
      source: await readFile(
        join(context.runtime.paths.pluginRoot, 'sdk/examples/strategy.py'),
        'utf8',
      ),
      parameters: {
        fast: 5,
        slow: 20,
        stop_loss_pct: 0.01,
        take_profit_pct: 0.02,
        trailing_stop: false,
      },
    }),
  );
  api.get('/', async (c) => c.json(await getRecords().list(c.get('userId'))));
  api.post('/', async (c) => {
    const body = strategySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(await getRecords().save(c.get('userId'), body.data), 201);
  });
  api.get('/:id', async (c) =>
    c.json(
      await getRecords().detail(c.get('userId'), readId(c.req.param('id'))),
    ),
  );
  api.put('/:id', async (c) => {
    const body = strategySchema
      .extend({ revision: z.number().int().positive() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(
      await getRecords().save(
        c.get('userId'),
        body.data,
        readId(c.req.param('id')),
        body.data.revision,
      ),
    );
  });
  api.get('/:id/versions', async (c) =>
    c.json(
      await getRecords().versions(c.get('userId'), readId(c.req.param('id'))),
    ),
  );
  api.post('/:id/versions', async (c) => {
    const body = z
      .object({
        revision: z.number().int().positive(),
        note: z.string().max(2000),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(
      await getRecords().publish(
        c.get('userId'),
        readId(c.req.param('id')),
        body.data.revision,
        body.data.note,
      ),
      201,
    );
  });
  api.get('/:id/runs', async (c) => {
    const before = c.req.query('before');
    if (before && !z.uuid().safeParse(before).success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(
      await getRecords().runs(
        c.get('userId'),
        readId(c.req.param('id')),
        before,
      ),
    );
  });
  api.post('/:id/runs', async (c) => {
    // A venv is a dependency environment, not a host security boundary.
    if (!c.get('isAdmin'))
      return c.json({ code: 'SCRIPT_EXECUTION_ADMIN_REQUIRED' }, 403);
    const body = backtestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'INVALID_BACKTEST_CONFIG' }, 400);
    const run = await enqueueBacktest(
      getRecords(),
      get(),
      { userId: c.get('userId'), isAdmin: c.get('isAdmin') },
      readId(c.req.param('id')),
      body.data,
    );
    return c.json(run, 202);
  });
  api.get('/runs/:runId/status', async (c) =>
    c.json(
      await getRecords().run(c.get('userId'), readId(c.req.param('runId'))),
    ),
  );
  api.post('/runs/:runId/cancel', async (c) =>
    c.json(
      await getRecords().cancel(c.get('userId'), readId(c.req.param('runId'))),
    ),
  );
  api.get('/runs/:runId/result', async (c) => {
    await getRecords().run(c.get('userId'), readId(c.req.param('runId')));
    const artifact = await getRecords().artifact(
      readId(c.req.param('runId')),
      'result',
    );
    const manifest = await getRecords().artifact(
      readId(c.req.param('runId')),
      'manifest',
    );
    return c.json({
      result: artifact ? JSON.parse(artifact.text) : null,
      manifest: manifest ? JSON.parse(manifest.text) : null,
    });
  });
  api.get('/runs/:runId/export', async (c) => {
    const run = await getRecords().run(
      c.get('userId'),
      readId(c.req.param('runId')),
    );
    const [version, dataset, result, manifest] = await Promise.all([
      getRecords().version(c.get('userId'), run.version_id),
      getRecords().artifact(run.id, 'dataset'),
      getRecords().artifact(run.id, 'result'),
      getRecords().artifact(run.id, 'manifest'),
    ]);
    c.header(
      'Content-Disposition',
      `attachment; filename="backtest-${run.id}.json"`,
    );
    return c.json({
      run,
      version,
      dataset: dataset ? JSON.parse(dataset.text) : null,
      dataset_hash: dataset?.hash,
      result: result ? JSON.parse(result.text) : null,
      manifest: manifest ? JSON.parse(manifest.text) : null,
    });
  });
  api.get('/runs/:runId/trades/:tradeId/volume-profile', async (c) => {
    const query = volumeProfileQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const run = await getRecords().run(
      c.get('userId'),
      readId(c.req.param('runId')),
    );
    const result = await getRecords().artifact(run.id, 'result');
    const trade =
      result &&
      (JSON.parse(result.text) as BacktestResult).trades.find(
        (item) => item.id === c.req.param('tradeId'),
      );
    if (!trade) throw new StrategyError('NOT_FOUND', 404);
    return c.json(
      await readVolumeProfile(
        get().store,
        run.engine,
        trade.symbol,
        query.data,
        get().trades,
        c.req.raw.signal,
      ),
    );
  });
  api.get('/runs/:runId/trades/:tradeId/bars', async (c) => {
    const query = marketBarsQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const run = await getRecords().run(
      c.get('userId'),
      readId(c.req.param('runId')),
    );
    const result = await getRecords().artifact(run.id, 'result');
    const trade =
      result &&
      (JSON.parse(result.text) as BacktestResult).trades.find(
        (item) => item.id === c.req.param('tradeId'),
      );
    if (!trade) throw new StrategyError('NOT_FOUND', 404);
    // A user's recorded trade authorizes its actual contract, even if it is no longer in their watchlist.
    const { store, state } = get();
    const [data, instrument] = await Promise.all([
      readMarketBars(store, run.engine, trade.symbol, query.data),
      query.data.around === undefined
        ? Promise.resolve(null)
        : state.instrument(run.engine, trade.symbol),
    ]);
    return c.json(
      Array.isArray(data)
        ? data
        : { ...data, priceTick: instrument?.priceTick ?? 0.01 },
    );
  });
  api.get('/runs/:runId/trades/:tradeId/replay', async (c) => {
    const query = replayQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ code: 'INVALID_REPLAY_QUERY' }, 400);
    const run = await getRecords().run(
      c.get('userId'),
      readId(c.req.param('runId')),
    );
    const [result, dataset] = await Promise.all([
      getRecords().artifact(run.id, 'result'),
      getRecords().artifact(run.id, 'dataset'),
    ]);
    const trade =
      result &&
      (JSON.parse(result.text) as BacktestResult).trades.find(
        (item) => item.id === c.req.param('tradeId'),
      );
    if (!trade || !dataset) return c.json({ code: 'TRADE_NOT_FOUND' }, 404);
    const data = JSON.parse(dataset.text) as ReplayDataset;
    return c.json({
      ...replayWindow(data, trade, query.data),
      snapshotHash: dataset.hash,
    });
  });
  return api;
}
