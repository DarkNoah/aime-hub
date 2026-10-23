import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { Hono } from 'hono';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import type { Bar, Instrument } from '../shared.js';
import type { BacktestInput } from '../strategy-types.js';
import { StrategyManagement1792600000000 } from '../server/strategies/migration.js';
import { StrategyStore } from '../server/strategies/store.js';
import { strategyRoutes } from '../server/strategies/routes.js';
import { BacktestWorker } from '../server/strategies/runner.js';
import { createPluginRuntime } from '../../../apps/server/src/modules/plugins/runtime.js';
import { parseConfig } from '../server/config.js';
import { MarketStore } from '../server/clickhouse.js';
import type { StateStore } from '../server/state-store.js';

export const start = Date.parse('2026-10-19T09:30:00+08:00') / 1000;
export const main = 'KQ.m@CFFEX.IM';
export const actual = 'CFFEX.IM2611';
export const commodity = 'KQ.m@SHFE.rb';
export const stock = 'SSE.600000';
export const input = (version_id: string, symbol = main): BacktestInput => ({
  version_id,
  symbol,
  duration: 60,
  start,
  end: start + 120 * 60,
  initial_cash: 1_000_000,
  slippage_ticks: 1,
  participation_rate: 0.1,
  annualization: 252,
  risk_free_rate: 0,
  benchmark_symbol: symbol,
  parameters: { fast: 2, slow: 4, quantity: symbol === stock ? 100 : 1 },
  rules: {
    multiplier: symbol === stock ? 1 : symbol === commodity ? 10 : 200,
    margin_rate: symbol === stock ? 1 : 0.12,
    lot_size: symbol === stock ? 100 : 1,
    t_plus_one: symbol === stock,
    fees: {
      per_unit: 1,
      rate: 0.00001,
      minimum: 0,
      close_today_per_unit: 2,
      close_today_rate: null,
      sell_tax_rate: 0,
    },
  },
  calendar: { '2026-10-19': true, '2026-10-20': true },
});
export async function strategyFixture() {
  const schema = `strategy_test_${randomUUID().replaceAll('-', '')}`;
  const admin = await new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
  }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db = await new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    extra: { options: `-c search_path=${schema}` },
  }).initialize();
  await db.query('CREATE TABLE users (id text PRIMARY KEY)');
  await db.query("INSERT INTO users VALUES ('alice'),('bob')");
  const migration = db.createQueryRunner();
  await new StrategyManagement1792600000000().up(migration);
  await migration.release();
  const workspace = await mkdtemp(join(tmpdir(), 'quant-strategy-'));
  const runtime = createPluginRuntime(
    { id: 'vibe-quant', workspace: true },
    { applicationRoot: process.cwd(), workspaceRoot: workspace },
  );
  const context: PluginContext = {
    id: 'vibe-quant',
    database: db,
    runtime,
    assertEnabled: async () => {},
  };
  const config = parseConfig({
    engine: 'tqsdk',
    tqUser: 'fixture',
    tqPassword: 'fixture',
    clickhouseUrl: 'http://127.0.0.1:18124',
    clickhouseDatabase: schema,
    clickhouseUser: 'test',
    clickhousePassword: 'test-only-local',
    maxSubscriptions: 10,
    beforeOpenMinutes: 5,
    afterCloseMinutes: 5,
    flushSeconds: 1,
    pollSeconds: 5,
    historyBars: 100,
  });
  const instruments: Instrument[] = [
    main,
    actual,
    'CFFEX.IM2612',
    commodity,
    'SHFE.rb2701',
    stock,
    'SSE.000300',
  ].map((symbol) => ({
    symbol,
    name:
      symbol === main
        ? 'IM 主连'
        : symbol === commodity
          ? '螺纹钢主连'
          : symbol === stock
            ? '浦发银行'
            : symbol,
    kind: symbol.startsWith('KQ')
      ? 'continuous'
      : symbol.startsWith('SSE.')
        ? 'stock'
        : 'future',
    exchange: symbol.split('.')[0],
    product: '',
    priceTick: symbol === stock ? 0.01 : 0.2,
    underlying: '',
    expired: false,
  }));
  let offset = 0;
  let missingMapping = false;
  const bars: Bar[] = instruments.flatMap((item) =>
    Array.from({ length: 120 }, (_, i) => {
      const price =
        (item.kind === 'stock' ? 10 : 8000) +
        Math.sin(i / 6) * (item.kind === 'stock' ? 0.2 : 10);
      return {
        symbol: item.symbol,
        duration: 60,
        time: start + i * 60,
        open: price,
        close: price + 0.01,
        high: price + (item.kind === 'stock' ? 0.1 : 2),
        low: price - (item.kind === 'stock' ? 0.1 : 2),
        volume: 10000,
      };
    }),
  );
  const state = {
    instrument: async (_engine: string, symbol: string) =>
      instruments.find((item) => item.symbol === symbol) ?? null,
  } as StateStore;
  const market = {
    barsAround: MarketStore.prototype.barsAround,
    table: () => 'fixture.quotes',
    rows: async (sql: string, params: Record<string, string>) => {
      if (missingMapping) return [];
      if (sql.includes('lagInFrame'))
        return params.symbol === main
          ? [{ time: start + 60 * 60, underlying: 'CFFEX.IM2612' }]
          : [];
      return [
        {
          time: start - 1,
          underlying: params.symbol === main ? actual : 'SHFE.rb2701',
        },
      ];
    },
    bars: async (
      _engine: string,
      symbol: string,
      duration: number,
      query: { after?: number; before?: number; limit?: number },
    ) => {
      const selected = bars
        .filter(
          (b) =>
            b.symbol === symbol &&
            b.duration === duration &&
            (query.after === undefined || b.time > query.after) &&
            (query.before === undefined || b.time < query.before),
        )
        .sort((a, b) => a.time - b.time);
      return (
        query.after === undefined
          ? selected.slice(-(query.limit ?? 1000))
          : selected.slice(0, query.limit ?? 1000)
      ).map((b) => ({
        ...b,
        open: b.open + offset,
        high: b.high + offset,
        low: b.low + offset,
        close: b.close + offset,
      }));
    },
  } as unknown as MarketStore;
  const records = new StrategyStore(config);
  await records.request(`CREATE DATABASE ${schema}`);
  await records.initialize();
  const python = resolve(
    process.env.QUANT_PYTHON ??
      'workspaces/plugins/vibe-quant/.venv/bin/python',
  );
  const worker = new BacktestWorker(
    context,
    records,
    { config, state, store: market },
    async () => python,
  );
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-user') ?? 'alice');
    c.set('isAdmin', c.req.header('x-admin') !== 'false');
    await next();
  });
  app.get('/instruments', (c) => c.json(instruments));
  app.route(
    '/strategies',
    strategyRoutes(
      context,
      () => records,
      () => ({
        store: market,
        trades: {
          readDay: async () => {
            throw new Error('No fixture trades');
          },
        },
        config,
        state,
        wake: () => worker.wake(),
      }),
    ),
  );
  return {
    app,
    records,
    db,
    worker,
    context,
    state,
    market,
    instruments,
    addMarketBars: (values: Bar[]) => bars.push(...values),
    config,
    mutateMarket: (value: number) => {
      offset = value;
    },
    missingMapping: () => {
      missingMapping = true;
    },
    request: (path: string, method = 'GET', body?: object, headers = {}) =>
      app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
    async close() {
      await worker.stop();
      await records.request(`DROP DATABASE ${schema}`);
      await db.destroy();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
