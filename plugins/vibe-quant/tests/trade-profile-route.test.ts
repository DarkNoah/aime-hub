import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import { strategyRoutes } from '../server/strategies/routes';
import { StrategyError } from '../server/strategies/schema';
import type { StrategyStore } from '../server/strategies/store';
import type { MarketStore } from '../server/clickhouse';
import type { StateStore } from '../server/state-store';
import type { QuantConfig } from '../server/config';

test('trade profile route authorizes the run and trade before requesting the independent source', async () => {
  const runId = randomUUID();
  const start = Date.parse('2026-10-22T10:00:00+08:00') / 1000;
  const requested: string[] = [];
  const records = {
    run: async (owner: string, id: string) => {
      if (owner !== 'alice' || id !== runId)
        throw new StrategyError('NOT_FOUND', 404);
      return { id, engine: 'tqsdk' };
    },
    artifact: async () => ({
      text: JSON.stringify({
        trades: [{ id: 'trade-1', symbol: 'CFFEX.IM2611' }],
      }),
    }),
  } as unknown as StrategyStore;
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-user') ?? 'alice');
    await next();
  });
  app.route(
    '/strategies',
    strategyRoutes(
      {} as PluginContext,
      () => records,
      () => ({
        config: {} as QuantConfig,
        state: {} as StateStore,
        store: {} as MarketStore,
        wake: () => {},
        trades: {
          readDay: async (symbol, date) => {
            requested.push(symbol);
            return {
              symbol,
              date,
              source: 'tdx-exhq-history',
              sourceSymbol: 'IM2611',
              market: 47,
              fetchedAt: start + 86400,
              isFinal: true,
              trades: [
                {
                  time: start,
                  price: 6500,
                  size: 10,
                  side: 'buy',
                  precision: 'second',
                  direction: 1,
                  openInterestChange: 0,
                  nature: 0,
                  natureName: '',
                },
              ],
            };
          },
        },
      }),
    ),
  );
  const path = `/strategies/runs/${runId}/trades/trade-1/volume-profile?from=${start}&to=${start + 300}&range=5m`;
  assert.equal(
    (await app.request(path, { headers: { 'x-user': 'bob' } })).status,
    404,
  );
  assert.equal(
    (await app.request(path.replace('trade-1', 'missing'))).status,
    404,
  );
  assert.equal(
    (await app.request(path.replace(`from=${start}`, `from=${start + 1}`)))
      .status,
    400,
  );
  assert.deepEqual(requested, []);
  const result = await app.request(path);
  assert.equal(result.status, 200);
  assert.deepEqual(requested, ['CFFEX.IM2611']);
  const data = await result.json();
  assert.match(data.source, /通达信/);
  assert.equal(data.segments[0].profile.rows[0].buy, 10);
});
