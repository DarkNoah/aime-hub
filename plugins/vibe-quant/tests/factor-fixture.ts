import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import type { Bar, Instrument } from '../shared.js';
import { parseConfig } from '../server/config.js';
import { FactorStore } from '../server/factors/store.js';
import { FactorService } from '../server/factors/service.js';
import { factorRoutes } from '../server/factors/routes.js';
import type { MarketStore } from '../server/clickhouse.js';
import type { StateStore } from '../server/state-store.js';

/** Dedicated ephemeral local database; no production configuration or credentials. */
export async function factorFixture() {
  const database = `factor_test_${randomUUID().replaceAll('-', '')}`;
  const config = parseConfig({
    engine: 'tqsdk',
    tqUser: 'fixture',
    tqPassword: 'fixture',
    clickhouseUrl: 'http://127.0.0.1:18124',
    clickhouseDatabase: database,
    clickhouseUser: 'test',
    clickhousePassword: 'test-only-local',
    maxSubscriptions: 100,
    beforeOpenMinutes: 5,
    afterCloseMinutes: 5,
    flushSeconds: 2,
    pollSeconds: 5,
    historyBars: 100,
  });
  const records = new FactorStore(config);
  await records.request(
    `CREATE DATABASE ${records.table('dummy').split('.')[0]}`,
  );
  await records.initialize();
  const workspace = await mkdtemp(join(tmpdir(), 'factor-service-'));
  const root = resolve('plugins/vibe-quant');
  const context = {
    runtime: {
      paths: { pluginRoot: root },
      ensureWorkspace: async () => workspace,
    },
  } as unknown as PluginContext;
  const instruments: Instrument[] = Array.from({ length: 6 }, (_, i) => ({
    symbol: `SHFE.test${i}2601`,
    name: `验证合约 ${i + 1}`,
    kind: 'future',
    exchange: 'SHFE',
    product: 'test',
    priceTick: 1,
    underlying: '',
    expired: false,
  }));
  const bars: Bar[] = [];
  let index = 0;
  for (
    let day = Date.parse('2026-01-05T09:00:00+08:00');
    day < Date.parse('2026-01-31T00:00:00+08:00');
    day += 86400_000
  ) {
    if ([0, 6].includes(new Date(day).getUTCDay())) continue;
    instruments.forEach((item, i) => {
      const price = 100 * (1 + 0.002 * (i + 1)) ** index;
      bars.push({
        symbol: item.symbol,
        duration: 86400,
        time: day / 1000,
        open: price,
        high: price * 1.01,
        low: price * 0.99,
        close: price,
        volume: 1000,
      });
    });
    index++;
  }
  const store = {
    bars: async (
      _engine: string,
      symbol: string,
      _duration: number,
      query: { before?: number; after?: number; limit?: number },
    ) => {
      const found = bars.filter(
        (b) =>
          b.symbol === symbol &&
          (query.before === undefined || b.time < query.before) &&
          (query.after === undefined || b.time > query.after),
      );
      return query.after === undefined
        ? found.slice(-(query.limit ?? 1000))
        : found.slice(0, query.limit ?? 1000);
    },
  } as unknown as MarketStore;
  const state = {
    instrument: async (_engine: string, symbol: string) =>
      instruments.find((i) => i.symbol === symbol) ?? null,
  } as unknown as StateStore;
  const service = new FactorService(
    context,
    records,
    { config, store, state },
    async () => resolve('workspaces/plugins/vibe-quant/.venv/bin/python'),
  );
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'test-admin');
    c.set('isAdmin', c.req.header('x-admin') !== 'false');
    await next();
  });
  app.route(
    '/factors',
    factorRoutes(context, () => ({ records, service })),
  );
  app.get('/instruments', (c) =>
    c.json(c.req.query('kind') === 'continuous' ? [] : instruments),
  );
  return {
    app,
    records,
    service,
    config,
    instruments,
    bars,
    close: async () => {
      await service.stop();
      await records.request(
        `DROP DATABASE ${records.table('dummy').split('.')[0]}`,
      );
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
