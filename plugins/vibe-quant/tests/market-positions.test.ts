import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { MarketPositionsPage } from '../market-positions.js';
import type { OpenTrade, Trade } from '../strategy-types.js';
import { ClickHouseClient } from '../server/clickhouse-client.js';
import type { QuantConfig } from '../server/config.js';
import {
  readMarketPositionMonths,
  readMarketPositions,
} from '../server/signals/positions.js';
import { signalRoutes } from '../server/signals/routes.js';
import type { MonitorStore, StoredMonitor } from '../server/signals/store.js';
import type { StrategyStore } from '../server/strategies/store.js';
import type { StateStore } from '../server/state-store.js';

const trade: Trade = {
  id: 'same-id',
  symbol: 'CFFEX.IM2611',
  side: 'long',
  quantity: 1,
  entry_time: 100,
  exit_time: 200,
  entry_price: 7000,
  exit_price: 7045,
  gross_pnl: 9000,
  net_pnl: 8990,
  fees: 10,
  entry_signal_id: null,
  exit_signal_id: null,
};
const opened: OpenTrade = {
  ...trade,
  status: 'open',
  exit_time: null,
  exit_price: null,
  gross_pnl: null,
  net_pnl: null,
  exit_signal_id: null,
  observed_until: 250,
};
const monitor = {
  id: 'm1',
  strategy_id: 's1',
  user_id: 'alice',
  engine: 'tqsdk',
  enabled: true,
  deleted: false,
  version_number: 2,
  revision: 1,
  config: { symbol: 'CFFEX.IM2611', duration: 60 },
} as StoredMonitor;

test('market positions scopes all source symbols to owner/display engine and keeps paused monitors', async () => {
  const queries: string[] = [];
  let reads = 0;
  const history = new ClickHouseClient({
    clickhouseDatabase: 'fixture',
  } as QuantConfig);
  history.rows = async <T>(
    query: string,
    params?: Record<string, string>,
  ): Promise<T[]> => {
    queries.push(query);
    assert.deepEqual(JSON.parse(params!.monitors), ['m1', 'm2']);
    if (query.includes('GROUP BY monitorId, month')) return [];
    return (
      query.includes("kind='summary'")
        ? [
            {
              monitorId: 'm2',
              opened: JSON.stringify([opened]),
              through: 250,
              replaying: 1,
            },
          ]
        : [
            {
              monitorId: 'm1',
              id: trade.id,
              time: trade.exit_time,
              payload: JSON.stringify(trade),
            },
          ]
    ) as T[];
  };
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'alice');
    await next();
  });
  app.route(
    '/strategies',
    signalRoutes(() => ({
      config: { engine: 'tqsdk' } as QuantConfig,
      state: {} as StateStore,
      records: {
        storedStrategy: async () => {
          reads++;
          return { name: '共同策略' };
        },
      } as unknown as StrategyStore,
      monitors: {
        list: async (owner: string) => {
          assert.equal(owner, 'alice');
          return [
            monitor,
            {
              ...monitor,
              id: 'm2',
              enabled: false,
              engine: 'tdx',
              config: {
                ...monitor.config,
                symbol: 'SSE.000852',
                display_symbol: 'CFFEX.IM2612',
                display_engine: 'tqsdk',
              },
            },
            { ...monitor, id: 'deleted', deleted: true },
            { ...monitor, id: 'other-engine', engine: 'tushare' },
          ];
        },
        view: async (row: StoredMonitor) => ({
          ...row,
          status: row.enabled ? 'running' : 'paused',
        }),
        history,
      } as unknown as MonitorStore,
      wake: () => {},
    })),
  );
  const response = await app.request('/strategies/monitors/positions');
  assert.equal(response.status, 200);
  const data = (await response.json()) as MarketPositionsPage;
  assert.equal(data.monitors.length, 2);
  assert.equal(data.monitors[1].status, 'paused');
  assert.equal(data.monitors[1].through, 250);
  assert.equal(data.monitors[1].replaying, true);
  assert.equal(data.open[0].monitor_id, 'm2');
  assert.equal(data.history[0].monitor_id, 'm1');
  assert.deepEqual(data.strategies, [{ id: 's1', name: '共同策略' }]);
  assert.deepEqual(data.monthly, []);
  assert.equal(reads, 1, 'shared strategy name is read once');
  assert.equal(
    queries.length,
    3,
    'history is read in batches, not once per monitor',
  );
});

test('strategy multi-select scopes positions and monthly totals before pagination while retaining all filter choices', async () => {
  const available = [
    monitor,
    { ...monitor, id: 'm2' },
    { ...monitor, id: 'm3', strategy_id: 's2' },
    { ...monitor, id: 'm4', strategy_id: 's3' },
    { ...monitor, id: 'deleted', strategy_id: 'deleted', deleted: true },
    {
      ...monitor,
      id: 'other-engine',
      strategy_id: 'other-engine',
      engine: 'tdx',
    },
  ] as StoredMonitor[];
  const queried: string[][] = [];
  const history = new ClickHouseClient({
    clickhouseDatabase: 'fixture',
  } as QuantConfig);
  history.rows = async <T>(
    query: string,
    params?: Record<string, string>,
  ): Promise<T[]> => {
    const ids: string[] = JSON.parse(params!.monitors);
    queried.push(ids);
    if (query.includes('GROUP BY monitorId, month')) {
      assert.equal(
        params!.time,
        undefined,
        'monthly totals have no page cursor',
      );
      assert.doesNotMatch(query, /LIMIT|\(time,monitorId,id\)</);
      return ids.map((id) => ({
        monitorId: id,
        month: '2026-10',
        net_pnl: 100,
        gross_profit: 120,
        gross_loss: -20,
        winning_trades: '2',
        losing_trades: '1',
        breakeven_trades: '1',
      })) as T[];
    }
    if (query.includes("kind='summary'"))
      return ids.map((id) => ({
        monitorId: id,
        opened: JSON.stringify([opened]),
        through: 250,
        replaying: false,
      })) as T[];
    assert.match(query, /LIMIT 51/);
    return Array.from({ length: 51 }, (_, index) => ({
      monitorId: ids[index % ids.length],
      id: String(index),
      time: 200 - index,
      payload: JSON.stringify({ ...trade, id: String(index) }),
    })) as T[];
  };
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'alice');
    await next();
  });
  app.route(
    '/strategies',
    signalRoutes(() => ({
      config: { engine: 'tqsdk' } as QuantConfig,
      state: {} as StateStore,
      records: {
        storedStrategy: async (id: string) => {
          assert.ok(['s1', 's2', 's3'].includes(id));
          return { name: `策略 ${id}` };
        },
      } as unknown as StrategyStore,
      monitors: {
        list: async (owner: string) => {
          assert.equal(owner, 'alice');
          return available;
        },
        view: async (row: StoredMonitor) => ({ ...row, status: 'running' }),
        history,
      } as unknown as MonitorStore,
      wake: () => {},
    })),
  );
  const path =
    '/strategies/monitors/positions?strategy=s1&strategy=s2&strategy=s1';
  const response = await app.request(path);
  assert.equal(response.status, 200);
  const first = (await response.json()) as MarketPositionsPage;
  assert.deepEqual(
    first.monitors.map((row) => row.id),
    ['m1', 'm2', 'm3'],
  );
  assert.deepEqual(
    first.open.map((row) => row.monitor_id),
    ['m3', 'm2', 'm1'],
  );
  assert.equal(first.history.length, 50);
  assert.ok(first.next);
  assert.ok(first.history.every((row) => row.monitor_id !== 'm4'));
  assert.deepEqual(
    first.strategies.map((row) => row.id),
    ['s1', 's2', 's3'],
  );
  assert.deepEqual(first.monthly, [
    {
      month: '2026-10',
      unit: 'currency',
      net_pnl: 300,
      gross_profit: 360,
      gross_loss: -60,
      winning_trades: 6,
      losing_trades: 3,
      breakeven_trades: 3,
    },
  ]);
  const second = await app.request(`${path}&before=${first.next}`);
  assert.equal(second.status, 200);
  assert.deepEqual(
    ((await second.json()) as MarketPositionsPage).monthly,
    first.monthly,
  );
  assert.equal(queried.length, 6);
  assert.ok(queried.every((ids) => JSON.stringify(ids) === '["m1","m2","m3"]'));

  const unknown = await app.request(
    '/strategies/monitors/positions?strategy=foreign&strategy=deleted&strategy=other-engine',
  );
  assert.equal(unknown.status, 200);
  const empty = (await unknown.json()) as MarketPositionsPage;
  assert.deepEqual(empty, {
    strategies: first.strategies,
    monitors: [],
    open: [],
    history: [],
    monthly: [],
    next: null,
  });
  assert.equal(
    queried.length,
    6,
    'unknown selections never expand scope or query history',
  );
});

test('monthly totals merge compatible monitors, retain separate units and normalize ClickHouse counts', async () => {
  const store = new ClickHouseClient({
    clickhouseDatabase: 'fixture',
  } as QuantConfig);
  const base = {
    month: '2026-10',
    net_pnl: 90,
    gross_profit: 120,
    gross_loss: -30,
    winning_trades: '2',
    losing_trades: '1',
    breakeven_trades: '1',
  };
  store.rows = async <T>(
    query: string,
    params?: Record<string, string>,
  ): Promise<T[]> => {
    assert.deepEqual(JSON.parse(params!.monitors), ['m1', 'm2', 'm3']);
    assert.match(query, /quant_signal_history`? FINAL/);
    assert.match(
      query,
      /JSONExtract\(payload, 'exit_time', 'Nullable\(Float64\)'\)/,
    );
    assert.match(
      query,
      /JSONExtract\(payload, 'net_pnl', 'Nullable\(Float64\)'\)/,
    );
    assert.match(
      query,
      /toDateTime64\(exit_time, 3, 'Asia\/Shanghai'\), '%Y-%m'/,
    );
    assert.match(query, /isNotNull\(pnl\) AND isFinite\(pnl\)/);
    assert.doesNotMatch(query, /LIMIT/);
    return [
      { ...base, monitorId: 'm1' },
      { ...base, monitorId: 'm2' },
      { ...base, monitorId: 'm3' },
      { ...base, monitorId: 'm1', month: '2026-09' },
    ] as T[];
  };
  const totals = await readMarketPositionMonths(store, [
    monitor,
    { ...monitor, id: 'm2' },
    {
      ...monitor,
      id: 'm3',
      config: { ...monitor.config, symbol: 'SSE.000852' },
    },
  ]);
  assert.deepEqual(totals, [
    {
      month: '2026-10',
      unit: 'currency',
      net_pnl: 180,
      gross_profit: 240,
      gross_loss: -60,
      winning_trades: 4,
      losing_trades: 2,
      breakeven_trades: 2,
    },
    {
      month: '2026-10',
      unit: 'points',
      net_pnl: 90,
      gross_profit: 120,
      gross_loss: -30,
      winning_trades: 2,
      losing_trades: 1,
      breakeven_trades: 1,
    },
    {
      month: '2026-09',
      unit: 'currency',
      net_pnl: 90,
      gross_profit: 120,
      gross_loss: -30,
      winning_trades: 2,
      losing_trades: 1,
      breakeven_trades: 1,
    },
  ]);
  store.rows = async () => {
    throw new Error('unexpected database read');
  };
  assert.deepEqual(await readMarketPositionMonths(store, []), []);
});

test('market positions has unbounded current holdings and a composite cursor for ties across strategies', async () => {
  const store = new ClickHouseClient({
    clickhouseDatabase: 'fixture',
  } as QuantConfig);
  const closed = Array.from({ length: 51 }, (_, i) => ({
    monitorId: i < 25 ? 'm2' : 'm1',
    id: String(100 - i),
    time: 200,
    payload: JSON.stringify({
      ...trade,
      id: String(100 - i),
      risk_levels: [{ id: 'large-unused-chart-data' }],
    }),
  }));
  store.rows = async <T>(
    query: string,
    params?: Record<string, string>,
  ): Promise<T[]> => {
    if (query.includes("kind='summary'")) {
      assert.ok(
        !query.includes('LIMIT'),
        'current positions must not be capped by history pagination',
      );
      return [
        {
          monitorId: 'm1',
          through: 250,
          replaying: 0,
          opened: JSON.stringify(
            Array.from({ length: 60 }, (_, i) => ({
              ...opened,
              id: String(i),
              entry_time: i,
            })),
          ),
        },
      ] as T[];
    }
    assert.match(query, /ORDER BY time DESC,monitorId DESC,id DESC LIMIT 51/);
    if (params?.monitor) {
      assert.match(query, /\(time,monitorId,id\)</);
      assert.equal(params.monitor, 'm1');
      assert.equal(params.time, '200');
      assert.equal(params.id, '51');
      return closed.slice(50) as T[];
    }
    return closed as T[];
  };
  const first = await readMarketPositions(store, ['m1', 'm2']);
  assert.equal(first.open.length, 60);
  assert.equal(first.open[0].trade.entry_time, 59);
  assert.equal(first.history.length, 50);
  assert.equal(first.history[0].trade.risk_levels, undefined);
  assert.ok(first.next);
  const second = await readMarketPositions(store, ['m1', 'm2'], first.next);
  assert.equal(second.history.length, 1);
  assert.equal(second.next, null);
  assert.equal(
    second.open.length,
    60,
    'older history pages still return latest current holdings',
  );
  assert.equal(
    new Set(
      [...first.history, ...second.history].map(
        (row) => `${row.monitor_id}:${row.trade.id}`,
      ),
    ).size,
    51,
  );
});

test('empty scope never reads history, and invalid cursors cannot expand the scope', async () => {
  const store = new ClickHouseClient({} as QuantConfig);
  store.rows = async () => {
    throw new Error('unexpected database read');
  };
  assert.deepEqual(await readMarketPositions(store, []), {
    open: [],
    history: [],
    progress: [],
    next: null,
  });
  for (const cursor of [
    '',
    'invalid',
    Buffer.from(
      JSON.stringify({ time: '200', monitor: 'foreign', id: 'x' }),
    ).toString('base64url'),
  ]) {
    await assert.rejects(
      readMarketPositions(store, [], cursor),
      /INVALID_MONITOR_CONFIG/,
    );
  }
});
