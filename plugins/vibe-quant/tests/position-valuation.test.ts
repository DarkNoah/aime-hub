import assert from 'node:assert/strict';
import test from 'node:test';
import { marketChartUrl, readMarketChartTarget } from '../market-navigation.js';
import type { MarketPositionMonitor } from '../market-positions.js';
import type { OpenTrade } from '../strategy-types.js';
import type { Quote } from '../shared.js';
import { positionValuation } from '../web/signals/position-valuation.js';
import { readMonitorMarketBars } from '../server/signals/market.js';
import type { MonitorStore } from '../server/signals/store.js';
import type { MarketStore } from '../server/clickhouse.js';
import { marketSignalNotificationSchema } from '@aime/shared/notifications';

const trade = {
  symbol: 'IM',
  side: 'long',
  quantity: 2,
  entry_price: 100,
  fees: 4,
  observed_until: 1000,
  unrealized_pnl: 3996,
  mark_price: 110,
  pnl_multiplier: 200,
} as OpenTrade;
const monitor = {
  engine: 'tqsdk',
  replaying: false,
  config: { symbol: 'IM', execution_model: 'actual_contract' },
} as MarketPositionMonitor;
const quote = { symbol: 'IM', time: 1001, last: 120 } as Quote;

test('live valuation uses matching fresh quotes and retains snapshot for stale, missing and replay quotes', () => {
  assert.equal(positionValuation(trade, monitor, quote, 'tqsdk').value, 7996);
  assert.equal(
    positionValuation({ ...trade, side: 'short' }, monitor, quote, 'tqsdk')
      .value,
    -8004,
  );
  for (const [q, engine, m] of [
    [quote, 'tdx', monitor],
    [{ ...quote, symbol: 'OTHER' }, 'tqsdk', monitor],
    [{ ...quote, time: 999 }, 'tqsdk', monitor],
    [{ ...quote, last: null }, 'tqsdk', monitor],
    [quote, 'tqsdk', { ...monitor, replaying: true }],
  ] as const)
    assert.equal(positionValuation(trade, m, q, engine).value, 3996);
  assert.equal(
    positionValuation({ ...trade, pnl_multiplier: 1 }, monitor, quote, 'tqsdk')
      .value,
    36,
  );
  assert.equal(
    positionValuation({ ...trade, unrealized_pnl: undefined }, monitor).value,
    null,
  );
});

test('notification chart links roundtrip symbol, source candle, monitor and period', () => {
  const target = {
    symbol: 'KQ.m@CFFEX.IM',
    time: 1792373460,
    duration: 300,
    monitor: 'monitor-a',
  };
  assert.deepEqual(
    readMarketChartTarget(
      new URL(marketChartUrl(target), 'https://local.test').search,
    ),
    target,
  );
  assert.equal(readMarketChartTarget('?symbol=IM&time=NaN'), null);
  assert.equal(readMarketChartTarget('?symbol=IM'), null);
  const parsed = marketSignalNotificationSchema.parse({
    type: 'exit',
    side: 'long',
    strategyName: 'test',
    version: 1,
    symbol: 'IM',
    time: 1000,
    price: 100,
    reason: '',
    pnl: { value: 0, unit: 'points', basis: 'realized' },
  });
  assert.equal(parsed.pnl?.value, 0);
});

test('monitor navigation authorizes owner, source symbol and source engine without a watchlist mutation', async () => {
  let deleted = false;
  const reads: unknown[][] = [];
  const monitors = {
    get: async (id: string, owner: string) => {
      assert.equal(id, 'monitor');
      if (owner !== 'alice') throw new Error('MONITOR_NOT_FOUND');
      return { id, engine: 'tdx', deleted, config: { symbol: 'SSE.000852' } };
    },
    history: {
      hasSymbol: async (_id: string, symbol: string) =>
        symbol === 'CFFEX.IM2611',
    },
  } as unknown as MonitorStore;
  const market = {
    barsAround: async (...args: unknown[]) => {
      reads.push(args);
      return { bars: [], targetTime: null };
    },
  } as unknown as MarketStore;
  const query = { duration: 300, around: 1000, limit: 1000 };
  await readMonitorMarketBars(
    monitors,
    market,
    'alice',
    'monitor',
    'SSE.000852',
    query,
  );
  await readMonitorMarketBars(
    monitors,
    market,
    'alice',
    'monitor',
    'CFFEX.IM2611',
    query,
  );
  assert.deepEqual(
    reads.map((args) => args.slice(0, 2)),
    [
      ['tdx', 'SSE.000852'],
      ['tdx', 'CFFEX.IM2611'],
    ],
  );
  await assert.rejects(
    readMonitorMarketBars(
      monitors,
      market,
      'bob',
      'monitor',
      'SSE.000852',
      query,
    ),
  );
  await assert.rejects(
    readMonitorMarketBars(
      monitors,
      market,
      'alice',
      'monitor',
      'UNRELATED',
      query,
    ),
  );
  deleted = true;
  await assert.rejects(
    readMonitorMarketBars(
      monitors,
      market,
      'alice',
      'monitor',
      'SSE.000852',
      query,
    ),
  );
  assert.equal(reads.length, 2);
});
