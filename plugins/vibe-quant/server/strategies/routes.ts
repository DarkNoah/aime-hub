import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import type { BacktestResult } from '../../strategy-types.js';
import { resultTradeRecords } from '../../strategy-trades.js';
import type { QuantConfig } from '../config.js';
import type { StateStore } from '../state-store.js';
import type { MarketStore } from '../clickhouse.js';
import { marketBarsQuery, readMarketBars } from '../market-bars.js';
import { readVolumeProfile, volumeProfileQuery } from '../volume-profile.js';
import type { TradeReader } from '../trades/service.js';
import { StrategyStore } from './store.js';
import {
  parseBacktestConfig,
  StrategyError,
  strategySchema,
  strategyStatusSchema,
} from './schema.js';
import { enqueueBacktest } from './enqueue.js';
import {
  replayQuerySchema,
  replayWindow,
  nativeMarketWindow,
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
        join(context.runtime.paths.pluginRoot, 'sdk/templates/strategy.py'),
        'utf8',
      ),
      parameters: {},
    }),
  );
  api.get('/', async (c) => {
    const status = strategyStatusSchema
      .or(z.literal('all'))
      .safeParse(c.req.query('status') ?? 'active');
    if (!status.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(await getRecords().list(c.get('userId'), status.data));
  });
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
  api.patch('/:id/status', async (c) => {
    const body = z
      .object({
        revision: z.number().int().positive(),
        status: strategyStatusSchema,
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(
      await getRecords().setStatus(
        c.get('userId'),
        readId(c.req.param('id')),
        body.data.revision,
        body.data.status,
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
  api.delete('/:id/versions/:versionId', async (c) => {
    const body = z
      .object({ revision: z.number().int().positive() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(
      await getRecords().deleteVersion(
        c.get('userId'),
        readId(c.req.param('id')),
        readId(c.req.param('versionId')),
        body.data.revision,
      ),
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
    const config = parseBacktestConfig(await c.req.json().catch(() => null));
    if (config.optimization)
      return c.json({ code: 'USE_OPTIMIZATION_ENDPOINT' }, 400);
    const run = await enqueueBacktest(
      getRecords(),
      get(),
      { userId: c.get('userId'), isAdmin: c.get('isAdmin') },
      readId(c.req.param('id')),
      config,
    );
    return c.json(run, 202);
  });
  api.get('/:id/optimizations', async (c) => {
    const before = c.req.query('before');
    if (before && !z.uuid().safeParse(before).success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(
      await getRecords().runs(
        c.get('userId'),
        readId(c.req.param('id')),
        before,
        'optimization',
      ),
    );
  });
  api.post('/:id/optimizations', async (c) => {
    if (!c.get('isAdmin'))
      return c.json({ code: 'SCRIPT_EXECUTION_ADMIN_REQUIRED' }, 403);
    const config = parseBacktestConfig(await c.req.json().catch(() => null));
    if (!config.optimization)
      return c.json({ code: 'INVALID_OPTIMIZATION_CONFIG' }, 400);
    return c.json(
      await enqueueBacktest(
        getRecords(),
        get(),
        { userId: c.get('userId'), isAdmin: c.get('isAdmin') },
        readId(c.req.param('id')),
        config,
      ),
      202,
    );
  });
  async function optimizationRun(owner: string, id: string) {
    const run = await getRecords().run(owner, readId(id));
    if (!run.config.optimization) throw new StrategyError('RUN_NOT_FOUND', 404);
    return run;
  }
  api.get('/optimizations/:runId/result', async (c) => {
    const run = await optimizationRun(c.get('userId'), c.req.param('runId'));
    const artifact = await getRecords().artifact(run.id, 'optimization');
    let draft = null;
    if (run.optimization_draft_id) {
      try {
        draft = await getRecords().detail(
          c.get('userId'),
          run.optimization_draft_id,
        );
      } catch (error) {
        if (!(
          error instanceof StrategyError && error.code === 'STRATEGY_NOT_FOUND'
        ))
          throw error;
      }
    }
    return c.json({
      run,
      optimization: artifact ? JSON.parse(artifact.text) : null,
      draft,
    });
  });
  api.post('/optimizations/:runId/cancel', async (c) => {
    const run = await optimizationRun(c.get('userId'), c.req.param('runId'));
    return c.json(await getRecords().cancel(c.get('userId'), run.id));
  });
  api.post('/optimizations/:runId/draft', async (c) => {
    const run = await optimizationRun(c.get('userId'), c.req.param('runId'));
    return c.json(
      await getRecords().createOptimizationDraft(c.get('userId'), run.id),
    );
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
    const run = await getRecords().run(
      c.get('userId'),
      readId(c.req.param('runId')),
    );
    const artifact = await getRecords().artifact(
      readId(c.req.param('runId')),
      'result',
    );
    const manifest = await getRecords().artifact(
      readId(c.req.param('runId')),
      'manifest',
    );
    const optimization = run.config.optimization
      ? await getRecords().artifact(run.id, 'optimization')
      : null;
    return c.json({
      result: artifact ? JSON.parse(artifact.text) : null,
      manifest: manifest ? JSON.parse(manifest.text) : null,
      optimization: optimization ? JSON.parse(optimization.text) : null,
    });
  });
  api.get('/runs/:runId/export', async (c) => {
    const run = await getRecords().run(
      c.get('userId'),
      readId(c.req.param('runId')),
    );
    const [version, dataset, result, manifest, optimization, validation] =
      await Promise.all([
        getRecords().version(c.get('userId'), run.version_id, true),
        getRecords().artifact(run.id, 'dataset'),
        getRecords().artifact(run.id, 'result'),
        getRecords().artifact(run.id, 'manifest'),
        run.config.optimization
          ? getRecords().artifact(run.id, 'optimization')
          : null,
        run.config.optimization
          ? getRecords().artifact(run.id, 'validation')
          : null,
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
      optimization: optimization ? JSON.parse(optimization.text) : null,
      validation: validation ? JSON.parse(validation.text) : null,
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
      resultTradeRecords(JSON.parse(result.text) as BacktestResult).find(
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
      resultTradeRecords(JSON.parse(result.text) as BacktestResult).find(
        (item) => item.id === c.req.param('tradeId'),
      );
    if (!trade) throw new StrategyError('NOT_FOUND', 404);
    // A user's recorded trade authorizes its actual contract, even if it is no longer in their watchlist.
    if (run.config?.backtest_engine === 'tqsdk') {
      const dataset = await getRecords().artifact(run.id, 'dataset');
      if (!dataset) throw new StrategyError('NOT_FOUND', 404);
      return c.json(
        nativeMarketWindow(
          JSON.parse(dataset.text) as ReplayDataset,
          trade,
          query.data,
          c.req.query('snapshot_intraday') === 'true',
        ),
      );
    }
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
      resultTradeRecords(JSON.parse(result.text) as BacktestResult).find(
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
