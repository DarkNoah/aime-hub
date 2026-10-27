import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { MarketStrategyHint, SignalOverlay } from '../signal-types.js';
import type { Trade } from '../strategy-types.js';
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
test('protective exits retain their trigger candle and distinct stop/target labels for both directions', () => {
  const bars = Array.from({ length: 4 }, (_, i) => ({
    symbol,
    duration: 60,
    time: start + i * 60,
    open: 100,
    high: 106,
    low: 98,
    close: 101,
    volume: 10,
  }));
  const signals = (
    ['take_profit', 'stop_loss', 'take_profit', 'stop_loss'] as const
  ).map((reason, i) => ({
    ...hint.signals[0],
    id: `exit-${i}`,
    type: 'exit' as const,
    side: i < 2 ? ('long' as const) : ('short' as const),
    reason,
    price: i < 2 ? 105 : 99,
    time: start + (i + 1) * 60,
    chart_time: start + i * 60,
  }));
  const markers = strategyHintMarkers([{ ...hint, signals }], bars, 60, 0.2);
  assert.equal(markers.length, 4);
  for (let i = 0; i < markers.length; i++) {
    assert.equal(markers[i].time, barLabelTime(signals[i].chart_time, 60));
    assert.match(markers[i].text ?? '', i % 2 === 0 ? /止盈离场/ : /止损离场/);
    assert.equal(markers[i].color, i % 2 === 0 ? '#dc4c5c' : '#16a085');
    assert.equal(markers[i].position, i < 2 ? 'aboveBar' : 'belowBar');
  }
  const strategyExit = strategyHintMarkers(
    [{ ...hint, signals: [{ ...signals[0], reason: 'orb_negative_pnl' }] }],
    bars,
    60,
    0.2,
  )[0];
  assert.match(strategyExit.text ?? '', /持仓超时亏损离场/);
  assert.doesNotMatch(strategyExit.text ?? '', /止损/);
});
test('market protection ranges reuse holding intervals, stop updates and trigger snapshots', () => {
  const levels = [
    { ...overlay.levels[0], id: 'r1', time: start, event_id: 'a' },
    {
      ...overlay.levels[0],
      id: 'r2',
      time: start + 60,
      stop_loss: 101,
      event_id: 'b',
    },
    {
      ...overlay.levels[0],
      id: 'r3',
      time: start + 120,
      stop_loss: 103,
      event_id: 'c',
    },
  ];
  const trade = {
    id: 't1',
    symbol,
    entry_signal_id: 'e1',
    entry_time: start,
    exit_time: start + 150,
    entry_price: 100,
    risk_level_id: 'r2',
    risk_levels: levels,
  } as Trade;
  const item = {
    ...hint,
    overlay: { updated_at: start, levels: [] },
    trades: [trade],
  };
  const drawings = strategyHintDrawings([item], bars, 60, 0.2);
  assert.equal(drawings.filter((d) => d.kind === 'box').length, 4);
  assert.ok(
    drawings.some((d) => d.from === d.to && d.top === 99 && d.bottom === 101),
  );
  assert.ok(
    drawings.every((d) => d.to <= 2.5),
    'protection ends at the actual exit',
  );
  assert.ok(
    drawings.every((d) => !d.id.includes('r3')),
    'later recalculations cannot overwrite the triggering protection',
  );
  assert.deepEqual(
    strategyHintDrawings(
      [{ ...item, trades: [{ ...trade, symbol: 'CFFEX.IM2612' }] }],
      bars,
      60,
      0.2,
    ),
    [],
    'actual contract risk prices cannot be drawn on another price series',
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
        history: {
          chart: async () => ({ trades: [], trades_truncated: false }),
        },
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

test('market history reads the independent monitor store; no manual backtest submission', async () => {
  const app = new Hono<PluginHttpEnv>();
  let deleted = false;
  app.use('*', async (c, next) => {
    c.set('userId', 'alice');
    await next();
  });
  app.onError((err, c) => c.json({ error: err.message }, 404));
  app.route(
    '/strategies',
    signalRoutes(() => ({
      config: { engine: 'tqsdk' } as QuantConfig,
      wake: () => {},
      state: {} as StateStore,
      records: {} as StrategyStore,
      monitors: {
        get: async (_id: string, owner: string) => {
          assert.equal(owner, 'alice');
          return { ...hint, deleted };
        },
        view: async () => hint,
        history: {
          read: async (id: string, before: string) => {
            assert.equal(id, 'm1');
            assert.equal(before, 'cursor');
            return {
              summary: { through: start },
              trades: [{ id: 'trade' }],
              signals: hint.signals,
              next: null,
            };
          },
        },
      } as unknown as MonitorStore,
    })),
  );
  const response = await app.request(
    '/strategies/monitors/m1/history?before=cursor',
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.trades[0].id, 'trade');
  assert.equal(result.summary.through, start);
  assert.equal(result.monitor.id, 'm1');
  assert.equal(
    (await app.request('/strategies/monitors/m1/history', { method: 'POST' }))
      .status,
    404,
  );
  deleted = true;
  assert.equal(
    (await app.request('/strategies/monitors/m1/history?before=cursor')).status,
    404,
  );
});

test('automatic history range is scoped to engine and instrument, with derived three-minute bars using minute data', async () => {
  const { strategyDataRoutes } = await import('../server/sdk/routes.js');
  const dependencies = {
    config: { engine: 'tqsdk' },
    store: {
      table: () => 'bars',
      rows: async (_query: string, params: Record<string, string>) => {
        assert.deepEqual(params, { engine: 'tqsdk', symbol, duration: '60' });
        return [{ start: 1, end: 100 }];
      },
    },
  };
  const app = strategyDataRoutes(
    () =>
      dependencies as unknown as ReturnType<
        Parameters<typeof strategyDataRoutes>[0]
      >,
  );
  const result = await app.request(
    `/history/range?symbol=${symbol}&duration=180`,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { start: 1, end: 100 });
  assert.equal(
    (await app.request(`/history/range?symbol=${symbol}&duration=17`)).status,
    400,
  );
});

test('main-price simulation requests only stored main prices in larger bounded pages', async () => {
  const { strategyDataRoutes } = await import('../server/sdk/routes.js');
  const main = 'KQ.m@CFFEX.IM';
  let bounds: { rebuildTicks?: boolean; limit?: number } = {};
  const dependencies = {
    config: { engine: 'tqsdk' },
    state: {
      instrument: async (_engine: string, requested: string) => ({
        symbol: requested,
        kind: requested === main ? 'continuous' : 'future',
      }),
    },
    store: {
      bars: async (
        _engine: string,
        _symbol: string,
        _duration: number,
        query: typeof bounds,
      ) => {
        bounds = query;
        return [];
      },
    },
  };
  const api = strategyDataRoutes(
    () =>
      dependencies as unknown as ReturnType<
        Parameters<typeof strategyDataRoutes>[0]
      >,
  );
  assert.equal(
    (
      await api.request(
        `/history?symbol=${main}&duration=60&after=1&before=1000&limit=5000&execution_model=continuous_price`,
      )
    ).status,
    200,
  );
  assert.equal(bounds.rebuildTicks, false);
  assert.equal(bounds.limit, 5000);
  assert.equal(
    (
      await api.request(
        `/history?symbol=${symbol}&duration=60&after=1&before=1000&execution_model=continuous_price`,
      )
    ).status,
    400,
  );
});

test('cross-symbol markers bind to display chart, retain source prices and omit foreign risk lines', () => {
  const chartSymbol = 'SZSE.000852';
  const cross = {
    ...hint,
    config: { ...hint.config, display_symbol: chartSymbol },
    signals: [{ ...hint.signals[0], price: 7001.25 }],
  };
  const chart = bars.map((bar) => ({ ...bar, symbol: chartSymbol }));
  const markers = strategyHintMarkers([cross], chart, 60, 1);
  assert.equal(markers.length, 1);
  assert.match(markers[0].text ?? '', /CFFEX.IM2611/);
  assert.match(markers[0].text ?? '', /7001.25/);
  assert.equal(strategyHintLines([cross], chartSymbol).length, 0);
  assert.equal(strategyHintMarkers([cross], bars, 60, 1).length, 0);
});
