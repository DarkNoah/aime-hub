import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { MarketStrategyHint, SignalOverlay } from '../signal-types.js';
import type { Bar } from '../shared.js';
import {
  strategyHintMarkers,
  strategyHintLines,
  strategyHintDrawings,
} from '../web/signals/chart-overlays.js';
import { barLabelTime } from '../web/chart-time.js';
import { signalRoutes } from '../server/signals/routes.js';
import type { MonitorStore, StoredMonitor } from '../server/signals/store.js';
import type { StrategyStore } from '../server/strategies/store.js';
import type { QuantConfig } from '../server/config.js';
import type { StateStore } from '../server/state-store.js';

const symbol = 'CFFEX.IM2611',
  start = 1792373400;
const overlay: SignalOverlay = {
  updated_at: start + 60,
  levels: [
    {
      id: 'r1',
      symbol,
      entry_signal_id: 'e1',
      time: start + 60,
      stop_loss: 99,
      take_profit: 105,
      chart_stop_loss: 99,
      chart_take_profit: 105,
    },
  ],
};
const hint = {
  id: 'm1',
  strategy_id: 'strategy',
  version_number: 1,
  strategy_name: '测试策略',
  enabled: true,
  notifications_enabled: false,
  status: 'running',
  revision: 1,
  engine: 'tqsdk',
  config: { symbol, duration: 60 },
  overlay,
  signals: [
    {
      id: 'e1',
      monitor_id: 'm1',
      symbol,
      time: start + 121,
      chart_time: start,
      type: 'entry',
      side: 'long',
      price: 100,
      reason: '',
    },
  ],
} as MarketStrategyHint;
const bars = Array.from({ length: 3 }, (_, i) => ({
  symbol,
  time: start + i * 60,
  duration: 60,
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 1000,
})) as Bar[];
test('chart anchors use source candle time; notification mute keeps markers and protection lines', () => {
  const markers = strategyHintMarkers([hint], bars, 60, 0.2);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].time, barLabelTime(start, 60));
  assert.match(markers[0].text ?? '', /入场 100/);
  assert.deepEqual(
    strategyHintLines([hint], symbol).map((line) => line.price),
    [105, 99],
  );
  assert.equal(
    strategyHintLines([{ ...hint, enabled: false }], symbol).length,
    0,
  );
  assert.equal(
    strategyHintLines([{ ...hint, status: 'error' }], symbol).length,
    0,
  );
  assert.equal(
    strategyHintMarkers(
      [hint],
      bars.map((bar) => ({ ...bar, symbol: 'SSE.600000' })),
      60,
      0.2,
    ).length,
    0,
  );
  assert.equal(strategyHintLines([hint], 'SSE.600000').length, 0);
  assert.equal(strategyHintMarkers([hint], [], 60, 0.2).length, 0);
  assert.equal(
    strategyHintLines(
      [{ ...hint, overlay: { updated_at: start, levels: [] } }],
      symbol,
    ).length,
    0,
  );
  const unavailable = {
    ...hint,
    overlay: {
      ...overlay,
      levels: overlay.levels.map((level) => ({
        ...level,
        chart_stop_loss: null,
        chart_take_profit: null,
      })),
    },
  };
  assert.equal(
    strategyHintLines([unavailable], symbol).length,
    0,
    'unmapped actual-contract prices are never drawn on a main chart',
  );
});
test('market API scopes hints by owner, instrument and engine; muting preserves calculation and future channels', async () => {
  let stored = {
    ...hint,
    user_id: 'alice',
    deleted: false,
    notifications: {
      channels: {
        toast: { enabled: true },
        future: { enabled: true, option: 'preserved' },
      },
    },
  } as unknown as StoredMonitor;
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'alice');
    c.set('isAdmin', false);
    await next();
  });
  app.route(
    '/strategies',
    signalRoutes(() => ({
      config: { engine: 'tqsdk' } as QuantConfig,
      state: {} as StateStore,
      records: {
        storedStrategy: async () => ({
          name: '测试策略',
          notifications: { channels: {} },
        }),
      } as unknown as StrategyStore,
      monitors: {
        list: async (owner: string) => {
          assert.equal(owner, 'alice');
          return [
            stored,
            {
              ...stored,
              id: 'other',
              config: { ...stored.config, symbol: 'SSE.600000' },
            },
            { ...stored, id: 'other-engine', engine: 'tdx' },
          ];
        },
        view: async (row: StoredMonitor) => row,
        signals: async (owner: string, id: string) => {
          assert.equal(owner, 'alice');
          assert.equal(id, 'm1');
          return hint.signals;
        },
        overlay: async () => overlay,
        get: async (id: string, owner: string) => {
          assert.equal(owner, 'alice');
          assert.equal(id, 'm1');
          return stored;
        },
        update: async (
          _owner: string,
          _id: string,
          revision: number,
          enabled: boolean,
          deleted: boolean,
          options: object,
        ) => {
          assert.equal(revision, stored.revision);
          stored = {
            ...stored,
            ...options,
            enabled,
            deleted,
            revision: revision + 1,
          };
          return stored;
        },
      } as unknown as MonitorStore,
      wake: () => {},
    })),
  );
  const response = await app.request(`/strategies/monitors?symbol=${symbol}`);
  assert.equal(response.status, 200);
  const rows = (await response.json()) as MarketStrategyHint[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].overlay.levels[0].stop_loss, 99);
  const changed = await app.request('/strategies/monitors/m1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 1, notifications_enabled: false }),
  });
  assert.equal(changed.status, 200);
  assert.equal(stored.enabled, true);
  assert.equal(stored.notifications_enabled, false);
  assert.equal(stored.notifications?.channels.future.option, 'preserved');
  const invalid = await app.request(
    '/strategies/monitors?symbol=../../foreign',
  );
  assert.equal(invalid.status, 400);
});

test('multiple strategies share coincident protection lines without overlapping labels', () => {
  const other = { ...hint, id: 'm2', strategy_name: '反转策略' };
  const drawings = strategyHintDrawings([hint, other], bars, 60, 0.2);
  assert.equal(drawings.length, 2);
  assert.ok(drawings.every((drawing) => drawing.clampLabel));
  assert.match(drawings[0].text ?? '', /测试策略.*反转策略/);
  assert.equal(
    strategyHintMarkers(
      [
        hint,
        {
          ...other,
          signals: other.signals.map((signal) => ({
            ...signal,
            id: 'other-signal',
          })),
        },
      ],
      bars,
      60,
      0.2,
    ).length,
    2,
  );
});

test('history reuses only matching versions, instruments, periods, engines and parameters; win rate excludes open trades', async () => {
  const { matchesMonitorRun, monitorHistoryInput } =
    await import('../signal-history.js');
  const { closedTradeWinRate } = await import('../strategy-trades.js');
  const { input } = await import('./strategy-fixture.js');
  const bound = {
    ...hint,
    config: {
      ...input('11111111-1111-4111-8111-111111111111', symbol),
      warmup_days: 7,
      events: { entry: true, exit: true },
    },
  };
  const config = monitorHistoryInput(bound, 12, start);
  assert.equal(config.version_id, bound.config.version_id);
  assert.deepEqual(config.parameters, bound.config.parameters);
  assert.equal(config.end, start);
  assert.ok(config.start < start - 365 * 86400);
  assert.equal(config.execution_model, 'actual_contract');
  config.rules.multiplier = 10;
  assert.equal(
    bound.config.rules.multiplier,
    200,
    'backtest defaults do not mutate the live configuration',
  );
  const run = {
    id: 'run',
    strategy_id: hint.strategy_id,
    version_id: config.version_id,
    engine: hint.engine,
    config,
  } as import('../strategy-types.js').BacktestRun;
  assert.equal(matchesMonitorRun(bound, run), true);
  assert.equal(matchesMonitorRun(bound, { ...run, engine: 'tdx' }), false);
  assert.equal(
    matchesMonitorRun(bound, { ...run, version_id: 'other' }),
    false,
  );
  assert.equal(
    matchesMonitorRun(bound, {
      ...run,
      config: { ...config, symbol: 'SSE.600000' },
    }),
    false,
  );
  assert.equal(
    matchesMonitorRun(bound, { ...run, config: { ...config, duration: 300 } }),
    false,
  );
  assert.equal(
    matchesMonitorRun(bound, {
      ...run,
      config: { ...config, parameters: { fast: 999 } },
    }),
    false,
  );
  assert.equal(
    matchesMonitorRun(bound, {
      ...run,
      config: {
        ...config,
        parameters: Object.fromEntries(
          Object.entries(config.parameters).reverse(),
        ),
      },
    }),
    true,
  );
  const trades = [
    { net_pnl: 10 },
    { net_pnl: -3 },
    { net_pnl: 0 },
  ] as import('../strategy-types.js').Trade[];
  assert.equal(closedTradeWinRate({ trades }), 1 / 3);
  assert.equal(closedTradeWinRate({ trades: [] }), null);

  const app = new Hono<PluginHttpEnv>();
  let submissions = 0;
  app.use('*', async (c, next) => {
    c.set('userId', 'alice');
    c.set('isAdmin', c.req.header('admin') === 'yes');
    await next();
  });
  app.route(
    '/strategies',
    signalRoutes(() => ({
      config: { engine: 'tqsdk' } as QuantConfig,
      wake: () => {},
      wakeBacktests: () => {},
      state: {
        instrument: async () => ({ symbol, kind: 'future' }),
      } as unknown as StateStore,
      monitors: {
        get: async (_id: string, owner: string) => {
          assert.equal(owner, 'alice');
          return bound;
        },
      } as unknown as MonitorStore,
      records: {
        runs: async (
          owner: string,
          _strategy: string,
          _before: string,
          _kind: string,
          monitor: typeof bound,
        ) => {
          assert.equal(owner, 'alice');
          assert.equal(monitor.id, bound.id);
          return [
            run,
            {
              ...run,
              id: 'wrong',
              config: { ...config, parameters: { fast: 999 } },
            },
          ];
        },
        enqueue: async (
          owner: string,
          strategy: string,
          value: typeof config,
        ) => {
          assert.equal(owner, 'alice');
          assert.equal(strategy, bound.strategy_id);
          assert.deepEqual(value.parameters, bound.config.parameters);
          submissions++;
          return { ...run, config: value };
        },
      } as unknown as StrategyStore,
    })),
  );
  const response = await app.request('/strategies/monitors/m1/history');
  assert.deepEqual(
    (await response.json()).runs.map((value: { id: string }) => value.id),
    ['run'],
  );
  const create = (admin: string, months = 12) =>
    app.request('/strategies/monitors/m1/history', {
      method: 'POST',
      headers: { admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ months }),
    });
  assert.equal((await create('no')).status, 403);
  assert.equal((await create('yes', 0)).status, 400);
  assert.equal(submissions, 0);
  assert.equal((await create('yes', 36)).status, 202);
  assert.equal(submissions, 1);
});
