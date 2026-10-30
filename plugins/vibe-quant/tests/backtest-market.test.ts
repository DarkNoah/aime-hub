import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import { strategyRoutes } from '../server/strategies/routes.js';
import { StrategyError } from '../server/strategies/schema.js';

const start = 1792373400;
const main = 'KQ.m@CFFEX.IM';
const contract = 'CFFEX.IM2611';
const bar = {
  symbol: main,
  duration: 60,
  time: start,
  open: 100,
  close: 101,
  low: 99,
  high: 102,
  volume: 20,
};
function fixture(native = false, withTrades = true) {
  const runId = randomUUID();
  const reads: unknown[][] = [];
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-user') ?? 'alice');
    await next();
  });
  app.route(
    '/strategies',
    strategyRoutes(
      {} as PluginContext,
      () =>
        ({
          run: async (owner: string, id: string) => {
            if (owner !== 'alice' || id !== runId)
              throw new StrategyError('NOT_FOUND', 404);
            return {
              id,
              engine: 'tqsdk',
              config: {
                symbol: main,
                start,
                end: start + 300,
                backtest_engine: native ? 'tqsdk' : 'builtin',
              },
            };
          },
          artifact: async (_id: string, type: string) => ({
            text: JSON.stringify(
              type === 'dataset'
                ? {
                    instruments: [{ symbol: main, price_tick: 0.2 }],
                    events: [0, 60, 120].map((offset) => ({
                      type: 'bar',
                      payload: {
                        ...bar,
                        time: start + offset,
                        trading_day: '2026-10-19',
                      },
                    })),
                  }
                : {
                    trades: withTrades
                      ? [
                          {
                            id: 't1',
                            symbol: contract,
                            entry_time: start,
                            exit_time: start + 60,
                          },
                        ]
                      : [],
                    fills: [],
                    orders: [],
                    equity_curve: [],
                  },
            ),
          }),
        }) as never,
      () => {
        if (native)
          throw new Error('Frozen backtests must not read current market data');
        return {
          store: {
            barsAround: async (...args: unknown[]) => {
              reads.push(args);
              return { bars: [{ ...bar, symbol: args[1] }], targetTime: start };
            },
            bars: async (...args: unknown[]) => {
              reads.push(args);
              return [bar];
            },
          },
          state: { instrument: async () => ({ priceTick: 0.2 }) },
          trades: {
            readDay: async (symbol: string) => {
              reads.push([symbol]);
              return { trades: [], isFinal: true };
            },
          },
        } as never;
      },
    ),
  );
  return { app, reads, base: `/strategies/runs/${runId}` };
}

test('the run chart is available without trades and shares the normal market reader', async () => {
  const { app, reads, base } = fixture(false, false);
  const response = await app.request(`${base}/bars?around=${start}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    bars: [bar],
    targetTime: start,
    priceTick: 0.2,
  });
  assert.deepEqual(reads, [['tqsdk', main, 60, start]]);
  assert.equal(
    (await app.request(`${base}/bars?after=${start}&limit=20`)).status,
    200,
  );
  assert.deepEqual(reads[1], [
    'tqsdk',
    main,
    60,
    { after: start, before: undefined, limit: 20 },
  ]);
});

test('run chart and volume profile authorize the owner and only recorded contracts', async () => {
  const { app, reads, base } = fixture();
  for (const suffix of [
    `bars?around=${start}`,
    `volume-profile?from=${start}&to=${start + 300}&range=5m`,
  ]) {
    const count = reads.length;
    assert.equal(
      (await app.request(`${base}/${suffix}`, { headers: { 'x-user': 'bob' } }))
        .status,
      404,
    );
    assert.equal(
      (await app.request(`${base}/${suffix}&symbol=CFFEX.IM9999`)).status,
      404,
    );
    assert.equal(reads.length, count);
    const response = await app.request(`${base}/${suffix}&symbol=${contract}`);
    assert.equal(response.status, 200);
  }
  assert.deepEqual(reads, [['tqsdk', contract, 60, start], [contract]]);
  assert.equal(
    (await app.request(`${base}/bars?around=${start}&before=${start + 60}`))
      .status,
    400,
  );
});

test('the native run chart reads and pages frozen candles even with no transactions', async () => {
  const { app, base } = fixture(true, false);
  const response = await app.request(`${base}/bars?around=${start}`);
  assert.equal(response.status, 200);
  const window = await response.json();
  assert.equal(window.priceTick, 0.2);
  assert.equal(window.targetTime, start);
  assert.deepEqual(
    window.bars.map((item: { time: number }) => item.time),
    [start, start + 60, start + 120],
  );
  const page = await app.request(`${base}/bars?after=${start + 60}&limit=1`);
  assert.deepEqual(
    (await page.json()).map((item: { time: number }) => item.time),
    [start + 120],
  );
  assert.equal(
    (await app.request(`${base}/bars?symbol=${contract}`)).status,
    404,
  );
});
