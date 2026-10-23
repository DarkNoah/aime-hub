import assert from 'node:assert/strict';
import test from 'node:test';
import {
  replayQuerySchema,
  replayWindow,
  type ReplayDataset,
} from '../server/strategies/replay.js';
import type { Trade } from '../strategy-types.js';
import { tradeMarkers } from '../web/trade-markers.js';

const start = Date.parse('2026-10-21T09:30:00+08:00') / 1000;
const symbol = 'CFFEX.IM2612';
const trade: Trade = {
  id: 'trade',
  symbol,
  side: 'long',
  quantity: 1,
  entry_time: start + 121 * 60,
  exit_time: start + 123 * 60,
  entry_price: 100,
  exit_price: 110,
  gross_pnl: 10,
  fees: 1,
  net_pnl: 9,
  entry_signal_id: null,
  exit_signal_id: null,
};
function fixture(count = 500): ReplayDataset {
  return {
    instruments: [{ symbol, price_tick: 0.2 }],
    events: Array.from({ length: count }, (_, i) => ({
      type: 'bar',
      payload: {
        symbol,
        duration: 60,
        time: start + i * 60,
        trading_day: '2026-10-21',
        open: 100 + i,
        high: 102 + i,
        low: 99 + i,
        close: 101 + i,
        volume: 10,
        amount: 1000,
        is_final: true,
      },
    })),
  };
}
function replay(
  data = fixture(),
  query: Record<string, unknown> = {},
  item = trade,
) {
  return replayWindow(data, item, replayQuerySchema.parse(query));
}
test('frozen replay centers 100 bars on each side and pages with strict cursors', () => {
  const view = replay();
  assert.equal(view.bars.length, 201);
  assert.equal(view.bars[100].time, trade.entry_time);
  assert.equal(view.targetTime, trade.entry_time);
  assert.equal(view.priceTick, 0.2);
  assert.equal(view.hasBefore, true);
  assert.equal(view.hasAfter, true);
  const before = replay(undefined, { before: view.bars[0].time, limit: 200 });
  assert.equal(before.bars.length, 21);
  assert.equal(before.hasBefore, false);
  assert.equal(before.bars.at(-1)!.time + 60, view.bars[0].time);
  const after = replay(undefined, {
    after: view.bars.at(-1)!.time,
    limit: 200,
  });
  assert.equal(after.bars.length, 200);
  assert.equal(after.bars[0].time, view.bars.at(-1)!.time + 60);
  assert.equal(replay(undefined, { after: start + 1000 * 60 }).bars.length, 0);
  assert.equal(replay(undefined, { before: start }).bars.length, 0);
  const latest = replay(undefined, { at: 'latest' });
  assert.equal(latest.bars.length, 200);
  assert.equal(latest.bars.at(-1)!.time, start + 499 * 60);
  assert.equal(latest.hasAfter, false);
  assert.equal(latest.targetTime, null);
  assert.equal(replay(undefined, { around: start - 1000 }).targetTime, start);
});
test('aggregation uses full buckets, actual contract only and preserves same-candle markers', () => {
  const data = fixture(3000);
  data.events.push({
    ...data.events[0],
    payload: {
      ...data.events[0].payload,
      symbol: 'KQ.m@CFFEX.IM',
      high: 1000000,
    },
  });
  data.events.push({
    ...data.events[0],
    payload: { ...data.events[0].payload, is_final: false, high: 1000000 },
  });
  const view = replay(data, { duration: 300 });
  assert.equal(view.bars[0].open, 100);
  assert.equal(view.bars[0].close, 105);
  assert.equal(view.bars[0].high, 106);
  assert.equal(view.bars[0].low, 99);
  assert.equal(view.bars[0].volume, 50);
  assert.equal(view.bars[0].amount, 5000);
  assert.equal(view.targetTime, start + 120 * 60);
  assert.deepEqual(view.markerTimes, {
    entry: start + 120 * 60,
    exit: start + 120 * 60,
  });
  assert.equal(
    tradeMarkers(trade, view.bars, 300, 0.2, view.markerTimes).length,
    2,
  );
  const page = replay(data, { duration: 300, before: start + 5000, limit: 1 });
  assert.equal(
    page.bars[0].volume,
    50,
    'cursor inside a bucket must not truncate aggregation',
  );
  const original = JSON.stringify(data);
  replay(data, { duration: 3600 });
  assert.equal(
    JSON.stringify(data),
    original,
    'aggregation must not mutate the snapshot',
  );
});
test('daily and calendar month replay include commodity night sessions in their trading day', () => {
  const data = fixture(4);
  const times = [
    '2026-10-30T14:59:00+08:00',
    '2026-10-30T21:00:00+08:00',
    '2026-10-31T00:00:00+08:00',
    '2026-11-02T09:00:00+08:00',
  ].map((t) => Date.parse(t) / 1000);
  data.events.forEach(({ payload }, index) => {
    payload.time = times[index];
    payload.trading_day = index === 0 ? '2026-10-30' : '2026-11-02';
  });
  const item = { ...trade, entry_time: times[1], exit_time: times[3] };
  for (const duration of [86400, 2592000]) {
    const view = replay(data, { duration }, item);
    assert.equal(view.bars.length, 2);
    assert.equal(view.bars[1].volume, 30);
    const bucket =
      Date.parse(
        duration === 86400
          ? '2026-11-02T00:00:00+08:00'
          : '2026-11-01T00:00:00+08:00',
      ) / 1000;
    assert.equal(view.targetTime, bucket);
    assert.deepEqual(view.markerTimes, { entry: bucket, exit: bucket });
    assert.deepEqual(
      tradeMarkers(item, view.bars, duration, 0.2, view.markerTimes).map(
        (m) => m.time,
      ),
      [bucket, bucket],
    );
  }
  const intraday = replay(data, { intraday: 'true' }, item);
  assert.deepEqual(
    intraday.bars.map((bar) => bar.time),
    times.slice(1),
  );
  assert.equal(intraday.hasBefore, false);
  assert.equal(intraday.hasAfter, false);
});
test('empty snapshots, missing marker anchors and duplicate candles are handled explicitly', () => {
  const data = fixture(1);
  data.events.push({
    type: 'bar',
    payload: { ...data.events[0].payload, close: 150 },
  });
  const view = replay(data);
  assert.equal(view.bars.length, 1);
  assert.equal(view.bars[0].close, 150);
  assert.deepEqual(view.markerTimes, { entry: null, exit: null });
  assert.deepEqual(
    tradeMarkers(trade, view.bars, 60, 0.2, view.markerTimes),
    [],
  );
  assert.equal(replay(fixture(0)).targetTime, null);
  assert.equal(replay(fixture(0)).range, null);
});
test('intrabar risk exits navigate to the triggering candle rather than the next accounting-time candle', () => {
  const item: Trade = {
    ...trade,
    exit_bar_time: trade.exit_time - 60,
    exit_time_precision: 'bar',
    exit_reason: 'stop_loss',
  };
  const view = replay(fixture(), { at: 'exit' }, item);
  assert.equal(view.targetTime, item.exit_bar_time);
  assert.equal(view.bars[100].time, item.exit_bar_time);
  assert.equal(view.markerTimes.exit, item.exit_bar_time);
  assert.match(
    tradeMarkers(item, view.bars, 60, 0.2, view.markerTimes)[1].text,
    /止损离场/,
  );
});

test('replay query validation disallows conflicting cursors and unsupported periods', () => {
  for (const query of [
    { duration: 7 },
    { around: start, before: start },
    { before: -1 },
    { limit: 1001 },
    { duration: 300, intraday: 'true' },
  ]) {
    assert.equal(replayQuerySchema.safeParse(query).success, false);
  }
});
