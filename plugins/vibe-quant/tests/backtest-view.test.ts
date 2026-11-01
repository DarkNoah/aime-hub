import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import type { BacktestResult, BacktestRun, Trade } from '../strategy-types.js';
import { resultTradeRecords, closedTradeWinRate } from '../strategy-trades.js';
import { strategyRoutes } from '../server/strategies/routes.js';
import { StrategyError } from '../server/strategies/schema.js';
import {
  MAX_CURVE_POINTS,
  overviewCurve,
  prepareResultView,
} from '../server/strategies/result-view.js';

function result(): BacktestResult {
  return {
    schema_version: 1,
    run_id: randomUUID(),
    status: 'completed',
    message: '',
    metrics: { max_drawdown: 0.37, total_pnl: 42, win_rate: 0.5 },
    equity_curve: Array.from({ length: 248_400 }, (_, i) => ({
      time: 1_700_000_000 + i * 60,
      trading_day: '2023-11-14',
      equity: 1000 + (i % 100),
      benchmark_equity: i % 71,
      positions: { test: { quantity: 123, large: 'x'.repeat(100) } },
    })),
    trades: Array.from({ length: 45 }, (_, i) => ({
      id: `t${i}`,
      symbol: 'test',
      side: 'long',
      quantity: 1,
      entry_time: 1_700_000_000 + i * 60,
      exit_time: 1_700_000_060 + i * 60,
      entry_price: 100,
      exit_price: 101,
      gross_pnl: 1,
      fees: 0.1,
      net_pnl: i % 2 ? -1 : 1,
      entry_signal_id: `s${i}`,
      exit_signal_id: null,
    })) as Trade[],
    orders: [],
    fills: [
      {
        id: 'open-fill',
        symbol: 'test',
        offset: 'open',
        quantity: 1,
        time: 1_700_003_000,
        price: 100,
        signal_id: 'open-signal',
        fee: 0.1,
      },
    ],
    signals: [],
    logs: Array.from({ length: 200 }, (_, i) => ({ message: `log${i}` })),
    risk_levels: [
      {
        id: 'risk1',
        event_id: 'e1',
        symbol: 'test',
        entry_signal_id: 's1',
        time: 1_700_000_060,
        stop_loss: 90,
        take_profit: 120,
      },
      {
        id: 'risk2',
        event_id: 'e2',
        symbol: 'another',
        entry_signal_id: 's1',
        time: 1_700_000_060,
        stop_loss: 90,
        take_profit: 120,
      },
    ],
    monthly_returns: [{ period: '2023-11', return: 0.1, pnl: 42 }],
    yearly_returns: [{ period: '2023', return: 0.1, pnl: 42 }],
    account: {},
    metric_notes: {},
  };
}

test('multi-year overview bounds the curve while preserving extrema, metrics, periods and open lots', () => {
  const full = result();
  full.equity_curve[1234].equity = -100;
  full.equity_curve[2345].equity = 10_000;
  full.equity_curve[3456].benchmark_equity = -10_000;
  full.equity_curve[4567].benchmark_equity = 20_000;
  const model = prepareResultView(full, null);
  const summary = model.view.result!;
  assert.ok(summary.equity_curve.length <= MAX_CURVE_POINTS);
  assert.ok(Buffer.byteLength(JSON.stringify(model.view)) < 400_000);
  assert.deepEqual(summary.metrics, full.metrics);
  assert.deepEqual(summary.monthly_returns, full.monthly_returns);
  assert.deepEqual(summary.yearly_returns, full.yearly_returns);
  assert.equal(summary.closed_win_rate, closedTradeWinRate(full));
  assert.equal(summary.curve_points, 248_400);
  assert.equal(summary.equity_curve[0].time, full.equity_curve[0].time);
  assert.equal(
    summary.equity_curve.at(-1)!.time,
    full.equity_curve.at(-1)!.time,
  );
  for (const i of [1234, 2345, 3456, 4567])
    assert.ok(
      summary.equity_curve.some((p) => p.time === full.equity_curve[i].time),
    );
  assert.ok(
    summary.equity_curve.every((p, i, rows) => !i || p.time > rows[i - 1].time),
  );
  assert.ok(summary.equity_curve.every((p) => !('positions' in p)));
  assert.equal(summary.trades.total, 46);
  assert.equal(summary.trades.items.length, 20);
  assert.deepEqual(summary.trades.items[0], resultTradeRecords(full).at(-1));
  assert.equal(model.logs.counts.logs, 200);
  assert.equal(model.logs.logs.length, 100);
  assert.equal(model.logs.logs[0].message, 'log100');
  // Creating the view must never rewrite the stored/raw result.
  assert.equal(full.equity_curve.length, 248_400);
  assert.equal(full.logs.length, 200);
});

test('small curves retain every unique time and the latest value at repeated timestamps', () => {
  const point = (time: number, equity: number) => ({
    time,
    equity,
    benchmark_equity: null,
    trading_day: '',
  });
  assert.deepEqual(overviewCurve([point(2, 2), point(1, 1), point(2, 3)]), [
    point(1, 1),
    point(2, 3),
  ]);
  assert.deepEqual(overviewCurve([]), []);
});

function fixture() {
  const full = result();
  const id = full.run_id;
  let deleted = false;
  let missing = false;
  let reads = 0;
  const records = {
    run: async (actor: string, runId: string) => {
      if (actor !== 'alice' || runId !== id || deleted)
        throw new StrategyError('RUN_NOT_FOUND', 404);
      return {
        id,
        status: 'completed',
        finished_at: '2026-11-01',
        config: {},
      } as BacktestRun;
    },
    artifact: async (_id: string, kind: string) => {
      reads++;
      if (missing) return null;
      return {
        text: JSON.stringify(
          kind === 'result'
            ? full
            : {
                sdk_version: '0.1.0',
                risk_model: 'fixture',
                data_snapshot_hash: 'hash',
                irrelevant_large_field: 'omit',
              },
        ),
      };
    },
  };
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-user') ?? 'alice');
    await next();
  });
  app.route(
    '/strategies',
    strategyRoutes(
      {} as PluginContext,
      () => records as never,
      () => ({}) as never,
    ),
  );
  return {
    app,
    full,
    base: `/strategies/runs/${id}`,
    reads: () => reads,
    remove: () => {
      deleted = true;
    },
    missing: () => {
      missing = true;
    },
    restore: () => {
      missing = false;
    },
  };
}

test('view APIs compress responses, page on the server and scope risk while preserving the full endpoint', async () => {
  const f = fixture();
  const response = await f.app.request(`${f.base}/view`, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Encoding'), 'gzip');
  assert.match(response.headers.get('Vary')!, /Accept-Encoding/);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length < 50_000);
  const view = JSON.parse(gunzipSync(bytes).toString());
  assert.equal(view.manifest.irrelevant_large_field, undefined);
  const second = await (
    await f.app.request(`${f.base}/view/trades?page=1`)
  ).json();
  assert.equal(second.items.length, 20);
  assert.ok(
    second.items.every(
      (item: Trade) =>
        !view.result.trades.items.some((first: Trade) => first.id === item.id),
    ),
  );
  const third = await (
    await f.app.request(`${f.base}/view/trades?page=2`)
  ).json();
  assert.equal(third.items.length, 6);
  const logs = await (await f.app.request(`${f.base}/view/logs`)).json();
  assert.equal(logs.logs.length, 100);
  const risk = await (
    await f.app.request(`${f.base}/view/risk?trade=t1`)
  ).json();
  assert.deepEqual(risk, [f.full.risk_levels![0]]);
  assert.equal(f.reads(), 2, 'pagination and details reuse the compact model');
  for (const page of ['-1', '1.2', 'NaN', '1000001'])
    assert.equal(
      (await f.app.request(`${f.base}/view/trades?page=${page}`)).status,
      400,
    );
  assert.equal(
    (await f.app.request(`${f.base}/view/risk?trade=missing`)).status,
    404,
  );
  const raw = await (await f.app.request(`${f.base}/result`)).json();
  assert.equal(raw.result.equity_curve.length, f.full.equity_curve.length);
  assert.equal(raw.result.logs.length, 200);
});

test('cached views still check access and deletion on every request', async () => {
  const f = fixture();
  await f.app.request(`${f.base}/view`);
  for (const path of [
    'view',
    'view/trades?page=1',
    'view/logs',
    'view/risk?trade=t1',
  ]) {
    assert.equal(
      (
        await f.app.request(`${f.base}/${path}`, {
          headers: { 'x-user': 'bob' },
        })
      ).status,
      404,
    );
  }
  f.remove();
  assert.equal((await f.app.request(`${f.base}/view`)).status, 404);
});

test('missing results are not cached and become visible once saved', async () => {
  const f = fixture();
  f.missing();
  assert.deepEqual(await (await f.app.request(`${f.base}/view`)).json(), {
    result: null,
    manifest: null,
  });
  assert.deepEqual(
    await (await f.app.request(`${f.base}/view/trades?page=0`)).json(),
    { items: [], total: 0, page_size: 20 },
  );
  assert.equal(f.reads(), 2);
  f.restore();
  const response = await f.app.request(`${f.base}/view`);
  assert.equal((await response.json()).result.trades.total, 46);
});
