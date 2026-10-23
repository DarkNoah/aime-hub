import assert from 'node:assert/strict';
import test from 'node:test';
import type { RiskLevelRecord, Trade } from '../strategy-types.js';
import { tradeRiskDrawings, tradeRiskLevels } from '../web/trade-risk.js';
import { TradeRiskPrimitive } from '../web/trade-risk-primitive.js';
import { tradeMarkers } from '../web/trade-markers.js';
import { tradeExitAnchor } from '../strategy-types.js';
import { exitReasonLabel } from '../web/trade-exit.js';

const trade: Trade = {
  id: 't1',
  symbol: 'IM2612',
  side: 'long',
  quantity: 1,
  entry_time: 120,
  exit_time: 360,
  entry_price: 100,
  exit_price: 110,
  gross_pnl: 10,
  fees: 0,
  net_pnl: 10,
  entry_signal_id: 'entry-1',
  exit_signal_id: 'exit',
};
const bars = Array.from({ length: 10 }, (_, i) => ({
  symbol: trade.symbol,
  duration: 60,
  time: i * 60,
  open: 100,
  close: 100,
  high: 110,
  low: 90,
  volume: 1,
}));
test('protective exits mark the trigger candle and keep the exact triggering snapshot', () => {
  const initial = level(120, 90);
  const triggering = level(180, 95);
  const later = level(240, 97);
  const item: Trade = {
    ...trade,
    exit_reason: 'stop_loss',
    exit_time: 360,
    exit_bar_time: 300,
    exit_time_precision: 'bar',
    risk_level_id: triggering.id,
  };
  assert.deepEqual(tradeRiskLevels(item, [initial, triggering, later]), [
    initial,
    triggering,
  ]);
  assert.equal(tradeExitAnchor(item), 300);
  const markers = tradeMarkers(item, bars, 60);
  assert.equal(
    markers.at(-1)!.time,
    360,
    'label time is the trigger candle close, not one candle later',
  );
  assert.match(markers.at(-1)!.text!, /止损离场/);
  assert.equal(exitReasonLabel('take_profit'), '止盈');
  assert.equal(exitReasonLabel('main_contract_roll'), '主力换月');
  assert.equal(exitReasonLabel(undefined), '未记录');
  assert.equal(exitReasonLabel('custom_exit'), 'custom_exit');
});
function level(
  time: number,
  stop_loss: number | null,
  take_profit: number | null = 110,
): RiskLevelRecord {
  return {
    id: `${time}:${stop_loss}:${take_profit}`,
    event_id: `e${time}`,
    time,
    symbol: trade.symbol,
    entry_signal_id: 'entry-1',
    stop_loss,
    take_profit,
  };
}
test('risk areas preserve causal steps, explicit clears and last write at the same time', () => {
  const records = tradeRiskLevels(trade, [
    level(100, 90),
    level(180, 95),
    level(180, 96),
    level(240, null),
    level(300, null, null),
    level(370, 100),
  ]);
  const areas = tradeRiskDrawings(trade, records, bars, 60).filter(
    (d) => d.kind === 'box',
  );
  assert.deepEqual(
    areas
      .filter((d) => d.id.includes('stop_loss'))
      .map((d) => [d.from, d.to, d.bottom]),
    [
      [2, 3, 90],
      [3, 4, 96],
    ],
  );
  assert.deepEqual(
    areas
      .filter((d) => d.id.includes('take_profit'))
      .map((d) => [d.from, d.to]),
    [
      [2, 3],
      [3, 4],
      [4, 5],
    ],
  );
  assert.ok(areas.every((d) => d.from >= 2 && d.to <= 6));
});
test('paging uses the active prior snapshot without leaking other entries or contracts', () => {
  const records = [
    level(100, 90),
    level(210, 97),
    { ...level(230, 999), entry_signal_id: 'entry-2' },
    { ...level(230, 888), symbol: 'IM2701' },
  ];
  const selected = tradeRiskLevels(trade, records);
  assert.equal(selected.length, 2);
  const paged = tradeRiskDrawings(trade, selected, bars.slice(4), 60);
  assert.deepEqual(
    paged
      .filter((d) => d.kind === 'box' && d.id.includes('stop_loss'))
      .map((d) => [d.from, d.to, d.bottom]),
    [[0, 2, 97]],
  );
  assert.deepEqual(tradeRiskDrawings(trade, selected, bars.slice(7), 60), []);
  assert.deepEqual(
    tradeRiskDrawings(
      { ...trade, entry_signal_id: null },
      tradeRiskLevels({ ...trade, entry_signal_id: null }, records),
      bars,
      60,
    ),
    [],
  );
});
test('intrabar and coarse candle views retain updates in temporal order for short positions too', () => {
  const coarse = [
    { ...bars[0], duration: 300 },
    { ...bars[5], duration: 300 },
  ];
  const drawings = tradeRiskDrawings(
    { ...trade, side: 'short' },
    [level(150, 105, 90), level(180, 103, 90)],
    coarse,
    300,
  );
  assert.deepEqual(
    drawings
      .filter((d) => d.kind === 'box' && d.id.includes('stop_loss'))
      .map((d) => [d.from, d.to, d.top]),
    [
      [0.5, 0.6, 105],
      [0.6, 1.2, 103],
    ],
  );
  const primitive = new TradeRiskPrimitive();
  primitive.setDrawings(drawings);
  assert.deepEqual(primitive.autoscaleInfo(0, 1), {
    priceRange: { minValue: 90, maxValue: 105 },
  });
  assert.equal(primitive.autoscaleInfo(2, 3), null);
});
