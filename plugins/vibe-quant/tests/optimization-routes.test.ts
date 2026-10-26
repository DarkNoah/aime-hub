import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import { strategyRoutes } from '../server/strategies/routes.js';
import type { StrategyStore } from '../server/strategies/store.js';
import { StrategyError } from '../server/strategies/schema.js';
import { input, actual } from './strategy-fixture.js';

test('optimization has a separate owner-scoped API and ordinary backtests reject it', async () => {
  const strategyId = randomUUID(),
    runId = randomUUID(),
    versionId = randomUUID();
  let admin = true;
  let user = 'alice';
  const calls: unknown[][] = [];
  const config = {
    ...input(versionId, actual),
    optimization: { search_space: { fast: { type: 'int', low: 2, high: 5 } } },
  };
  const run = {
    id: runId,
    strategy_id: strategyId,
    config,
    status: 'completed',
  };
  const records = {
    runs: async (...args: unknown[]) => {
      calls.push(['runs', ...args]);
      return [];
    },
    run: async (owner: string, id: string) => {
      if (owner !== 'alice' || id !== runId)
        throw new StrategyError('RUN_NOT_FOUND', 404);
      return run;
    },
    enqueue: async (...args: unknown[]) => {
      calls.push(['enqueue', ...args]);
      return run;
    },
    artifact: async () => ({ hash: 'hash', text: '{"status":"completed"}' }),
    createOptimizationDraft: async (owner: string, id: string) => {
      calls.push(['draft', owner, id]);
      return { id: 'new-draft', version_count: 0 };
    },
  } as unknown as StrategyStore;
  const api = new Hono<PluginHttpEnv>();
  api.use('*', async (c, next) => {
    c.set('userId', user);
    c.set('isAdmin', admin);
    await next();
  });
  api.route(
    '/strategies',
    strategyRoutes(
      {} as PluginContext,
      () => records,
      () =>
        ({
          config: { engine: 'tqsdk' },
          state: {
            instrument: async () => ({ symbol: actual, kind: 'future' }),
          },
          wake: () => {},
        }) as never,
    ),
  );
  const post = (path: string, payload: unknown = config) =>
    api.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  assert.equal((await post(`/strategies/${strategyId}/runs`)).status, 400);
  assert.equal(
    (await post(`/strategies/${strategyId}/optimizations`)).status,
    202,
  );
  const now = Math.floor(Date.now() / 1000);
  const future = { ...config, start: now - 86400, end: now + 86400 };
  for (const [endpoint, payload] of [
    ['runs', { ...future, optimization: undefined }],
    ['optimizations', future],
  ] as const) {
    assert.equal(
      (await post(`/strategies/${strategyId}/${endpoint}`, payload)).status,
      202,
    );
    assert.equal((calls.at(-1)?.[3] as typeof config).end, future.end);
    const invalidDate = await post(`/strategies/${strategyId}/${endpoint}`, {
      ...payload,
      end: payload.start,
    });
    assert.equal(invalidDate.status, 400);
    assert.deepEqual(await invalidDate.json(), {
      code: 'INVALID_BACKTEST_TIME_RANGE',
    });
  }
  const invalidOptimization = await post(
    `/strategies/${strategyId}/optimizations`,
    {
      ...config,
      optimization: { ...config.optimization, validation_start: config.end },
    },
  );
  assert.equal(invalidOptimization.status, 400);
  assert.deepEqual(await invalidOptimization.json(), {
    code: 'INVALID_OPTIMIZATION_CONFIG',
  });
  await api.request(`/strategies/${strategyId}/runs`);
  await api.request(`/strategies/${strategyId}/optimizations`);
  assert.deepEqual(
    calls.filter((v) => v[0] === 'runs').map((v) => v.at(-1)),
    [undefined, 'optimization'],
  );
  assert.equal(
    (await api.request(`/strategies/optimizations/${runId}/result`)).status,
    200,
  );
  assert.equal(
    (await post(`/strategies/optimizations/${runId}/draft`)).status,
    200,
  );
  admin = false;
  assert.equal(
    (await post(`/strategies/${strategyId}/optimizations`)).status,
    403,
  );
  user = 'bob';
  assert.equal(
    (await api.request(`/strategies/optimizations/${runId}/result`)).status,
    404,
  );
  assert.equal(
    (await post(`/strategies/optimizations/${runId}/draft`)).status,
    404,
  );
  assert.equal(calls.filter((v) => v[0] === 'draft').length, 1);
});
