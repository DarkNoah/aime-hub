import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { BacktestResult, BacktestRun } from '../../strategy-types.js';
import { resultTradeRecords } from '../../strategy-trades.js';
import { marketBarsQuery, readMarketBars } from '../market-bars.js';
import { readVolumeProfile, volumeProfileQuery } from '../volume-profile.js';
import type { MarketStore } from '../clickhouse.js';
import type { StateStore } from '../state-store.js';
import type { TradeReader } from '../trades/service.js';
import type { StrategyStore } from './store.js';
import { nativeMarketWindow, type ReplayDataset } from './replay.js';
import { StrategyError } from './schema.js';

/** One market source per run/contract, including runs without any trades. */
export function backtestMarketRoutes(
  getRecords: () => StrategyStore,
  getMarket: () => {
    store: MarketStore;
    state: StateStore;
    trades: TradeReader;
  },
) {
  const api = new Hono<PluginHttpEnv>();
  async function resolveRun(owner: string, id: string, requested?: string) {
    if (!z.uuid().safeParse(id).success)
      throw new StrategyError('NOT_FOUND', 404);
    const run = await getRecords().run(owner, id);
    const symbol = requested ?? run.config.symbol;
    if (symbol !== run.config.symbol) {
      const artifact = await getRecords().artifact(run.id, 'result');
      const trades = artifact
        ? resultTradeRecords(JSON.parse(artifact.text) as BacktestResult)
        : [];
      if (!trades.some((trade) => trade.symbol === symbol))
        throw new StrategyError('NOT_FOUND', 404);
    }
    return { run, symbol };
  }
  async function snapshot(run: BacktestRun) {
    const dataset = await getRecords().artifact(run.id, 'dataset');
    if (!dataset) throw new StrategyError('NOT_FOUND', 404);
    return JSON.parse(dataset.text) as ReplayDataset;
  }
  api.get('/runs/:runId/bars', async (c) => {
    const query = marketBarsQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { run, symbol } = await resolveRun(
      c.get('userId'),
      c.req.param('runId'),
      c.req.query('symbol'),
    );
    if (run.config.backtest_engine === 'tqsdk')
      return c.json(
        nativeMarketWindow(
          await snapshot(run),
          { symbol },
          query.data,
          c.req.query('snapshot_intraday') === 'true',
        ),
      );
    const { store, state } = getMarket();
    const [data, instrument] = await Promise.all([
      readMarketBars(store, run.engine, symbol, query.data),
      query.data.around === undefined
        ? Promise.resolve(null)
        : state.instrument(run.engine, symbol),
    ]);
    return c.json(
      Array.isArray(data)
        ? data
        : { ...data, priceTick: instrument?.priceTick ?? 0.01 },
    );
  });
  api.get('/runs/:runId/volume-profile', async (c) => {
    const query = volumeProfileQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { run, symbol } = await resolveRun(
      c.get('userId'),
      c.req.param('runId'),
      c.req.query('symbol'),
    );
    const { store, trades } = getMarket();
    return c.json(
      await readVolumeProfile(
        store,
        run.engine,
        symbol,
        query.data,
        trades,
        c.req.raw.signal,
      ),
    );
  });
  return api;
}
