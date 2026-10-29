import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { MarketPositionsPage } from '../market-positions.js';
import type { OpenTrade, Trade } from '../strategy-types.js';
import { ClickHouseClient } from '../server/clickhouse-client.js';
import type { QuantConfig } from '../server/config.js';
import { readMarketPositions } from '../server/signals/positions.js';
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
  assert.equal(reads, 1, 'shared strategy name is read once');
  assert.equal(
    queries.length,
    2,
    'history is read in batches, not once per monitor',
  );
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
