import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import type { BacktestResult, OpenTrade, Trade } from '../strategy-types.js';
import { resultTradeRecords } from '../strategy-trades.js';
import { tradeMarkers } from '../web/trade-markers.js';
import { tradeRiskDrawings, tradeRiskLevels } from '../web/trade-risk.js';
import {
  replayQuerySchema,
  replayWindow,
  type ReplayDataset,
} from '../server/strategies/replay.js';
import { strategyRoutes } from '../server/strategies/routes.js';
import { StrategyError } from '../server/strategies/schema.js';

const start = Date.parse('2026-10-22T10:00:00+08:00') / 1000;
const symbol = 'CFFEX.IM2611';
const fill = (id = 'fill-1', quantity = 3, time = start) => ({
  id,
  symbol,
  quantity,
  time,
  price: 6500,
  fee: 6,
  offset: 'open',
  signal_id: 'entry-1',
});
const closed: Trade = {
  id: 'trade-1',
  symbol,
  side: 'long',
  quantity: 1,
  entry_time: start,
  entry_price: 6500,
  entry_signal_id: 'entry-1',
  exit_time: start + 60,
  exit_price: 6501,
  exit_signal_id: 'exit-1',
  gross_pnl: 200,
  fees: 4,
  net_pnl: 196,
};
const result = (
  fills: Record<string, unknown>[] = [fill()],
  trades: Trade[] = [],
) =>
  ({
    fills,
    trades,
    orders: [],
    equity_curve: [{ time: start + 180 }],
  }) as unknown as BacktestResult;

test('old results expose unclosed entry fills without changing closed trades or inventing exits', () => {
  const saved = result();
  const before = JSON.stringify(saved);
  const rows = resultTradeRecords(saved);
  assert.equal(rows.length, 1);
  const open = rows[0] as OpenTrade;
  assert.equal(open.id, 'open:fill-1');
  assert.equal(open.status, 'open');
  assert.equal(open.quantity, 3);
  assert.equal(open.entry_time, start);
  assert.equal(open.exit_time, null);
  assert.equal(open.net_pnl, null);
  assert.equal(open.observed_until, start + 180);
  assert.equal(JSON.stringify(saved), before);
  assert.deepEqual(resultTradeRecords(result([], [closed])), [closed]);
});

test('partial exits leave only the remaining lot and proportional entry fee', () => {
  const rows = resultTradeRecords(result([fill()], [closed]));
  assert.equal(rows[0], closed);
  assert.equal(rows[1].quantity, 2);
  assert.equal(rows[1].fees, 4);
  assert.deepEqual(resultTradeRecords(result([fill('fill-1', 1)], [closed])), [
    closed,
  ]);
});

test('entry identity distinguishes partial fills, selective protective exits, short lots and contracts', () => {
  const fills = [
    fill('first', 1),
    fill('later', 1, start + 60),
    { ...fill('other-signal', 1), signal_id: 'entry-2' },
    { ...fill('other-contract', 1), symbol: 'CFFEX.IM2612' },
    fill('short', -2),
  ];
  const trades = [
    { ...closed, entry_time: start + 60 },
    { ...closed, id: 'short-exit', side: 'short' as const },
  ];
  const open = resultTradeRecords(result(fills, trades)).filter(
    (row) => row.status === 'open',
  );
  assert.deepEqual(
    open.map((row) => row.id),
    ['open:first', 'open:other-signal', 'open:other-contract', 'open:short'],
  );
  assert.equal(open.at(-1)?.quantity, 1);
  const duplicates = resultTradeRecords(
    result([fill('a', 1), fill('b', 2)], [closed]),
  );
  assert.deepEqual(
    duplicates.map((row) => row.id),
    ['trade-1', 'open:b'],
  );
});

const bars = Array.from({ length: 6 }, (_, i) => ({
  symbol,
  duration: 60,
  time: start + i * 60,
  open: 6500,
  close: 6500,
  high: 6510,
  low: 6490,
  volume: 100,
}));
const dataset: ReplayDataset = {
  instruments: [{ symbol, price_tick: 0.2 }],
  events: bars.map((bar) => ({
    type: 'bar',
    payload: { ...bar, trading_day: '2026-10-22' },
  })),
};
test('open replay locates entry, omits exit markers and bounds risk areas at the recorded run end', () => {
  const open = resultTradeRecords(result())[0];
  const view = replayWindow(dataset, open, replayQuerySchema.parse({}));
  assert.equal(view.targetTime, start);
  assert.deepEqual(view.markerTimes, { entry: start, exit: null });
  for (const anchors of [
    undefined,
    view.markerTimes,
    { entry: start, exit: start + 60 },
  ]) {
    const markers = tradeMarkers(open, view.bars, 60, 0.2, anchors);
    assert.equal(markers.length, 1);
    assert.match(markers[0].text!, /^入场/);
  }
  assert.equal(
    replayWindow(dataset, open, replayQuerySchema.parse({ at: 'exit' }))
      .targetTime,
    start,
  );
  const levels = [start, start + 240].map((time) => ({
    id: String(time),
    event_id: 'event',
    symbol,
    entry_signal_id: 'entry-1',
    time,
    stop_loss: 6490,
    take_profit: 6510,
  }));
  const selected = tradeRiskLevels(open, levels);
  assert.equal(selected.length, 1);
  const areas = tradeRiskDrawings(open, selected, bars, 60);
  assert.ok(areas.length);
  assert.ok(areas.every((area) => area.to <= 3));
});

test('open risk exits keep their triggered snapshot while waiting to close', () => {
  const saved = result();
  saved.orders = [
    {
      symbol,
      risk_entry_signal_id: 'entry-1',
      risk_level_id: 'triggered',
      status: 'cancelled',
    },
  ];
  const open = resultTradeRecords(saved)[0];
  assert.equal(open.risk_level_id, 'triggered');
});

test('open bars, replay and volume profile resolve the saved entry and enforce run ownership', async () => {
  const runId = randomUUID();
  const reads: unknown[][] = [];
  const api = new Hono<PluginHttpEnv>();
  api.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-user') ?? 'alice');
    await next();
  });
  api.route(
    '/strategies',
    strategyRoutes(
      {} as PluginContext,
      () =>
        ({
          run: async (owner: string, id: string) => {
            if (owner !== 'alice' || id !== runId)
              throw new StrategyError('NOT_FOUND', 404);
            return { id, engine: 'tqsdk' };
          },
          artifact: async (_id: string, type: string) => ({
            hash: 'frozen',
            text: JSON.stringify(type === 'dataset' ? dataset : result()),
          }),
        }) as never,
      () =>
        ({
          store: {
            barsAround: async (...args: unknown[]) => {
              reads.push(args);
              return {
                bars,
                targetTime: start,
                hasBefore: false,
                hasAfter: false,
              };
            },
          },
          state: { instrument: async () => ({ priceTick: 0.2 }) },
          trades: {
            readDay: async (symbol: string) => {
              reads.push([symbol]);
              return { trades: [], isFinal: true };
            },
          },
        }) as never,
    ),
  );
  const base = `/strategies/runs/${runId}/trades/open%3Afill-1`;
  for (const suffix of [
    `bars?around=${start}`,
    'replay',
    `volume-profile?from=${start}&to=${start + 300}&range=5m`,
  ]) {
    const previous = reads.length;
    assert.equal(
      (await api.request(`${base}/${suffix}`, { headers: { 'x-user': 'bob' } }))
        .status,
      404,
    );
    assert.equal(
      (await api.request(`${base.replace('fill-1', 'missing')}/${suffix}`))
        .status,
      404,
    );
    assert.equal(reads.length, previous);
    const response = await api.request(`${base}/${suffix}`);
    assert.equal(response.status, 200);
    if (suffix === 'replay') {
      const body = await response.json();
      assert.equal(body.trade.status, 'open');
      assert.equal(body.targetTime, start);
      assert.equal(body.markerTimes.exit, null);
    }
  }
  assert.deepEqual(reads[0], ['tqsdk', symbol, 60, start]);
  assert.deepEqual(reads[1], [symbol]);
});
