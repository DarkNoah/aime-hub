from dataclasses import replace
from datetime import date, datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Bar, Dataset, Event, Fees, Instrument, RunConfig, Strategy, backtest
from quant_sdk.runtime import Runner
from quant_sdk.point_metrics import summarize_points
from test_strategy_sdk import Schedule, candle
import test_strategy_prepare as prepare_test
from quant_sdk.state_codec import encode_state, decode_state

INDEX = 'SSE.000852'


class Protected(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(INDEX, 60)

    def on_bar(self, ctx, bar):
        if not ctx.state:
            ctx.state['started'] = True
            entry = ctx.orders.target_position(INDEX, 100)
            ctx.set_risk_levels(INDEX, stop_loss=95, take_profit=110, entry_id=entry)


class PointBacktestTest(unittest.TestCase):
    def run_strategy(self, strategy, item, events, config, **params):
        with tempfile.TemporaryDirectory() as root:
            result = backtest.run(strategy, Dataset([item], events), config=config,
                                  params={'symbol': item.symbol, **params}, output_dir=root)
            manifest = json.loads((Path(root) / result['run_id'] / 'manifest.json').read_text())
            return result, manifest

    def test_index_long_short_cost_drawdown_and_cash_independence(self):
        item = Instrument(INDEX, 'stock', .01, tradable=False, lot_size=100, t_plus_one=True,
                          fees=Fees(per_unit=999, rate=.5))
        events = [candle(INDEX, i, close, open_price=opening, volume=0)
                  for i, (opening, close) in enumerate([(100, 100), (110, 112), (130, 130),
                                                        (125, 125), (115, 116), (120, 120)])]
        config = RunConfig(pnl_mode='points', initial_cash=1, point_cost=1, participation_rate=.001,
                           benchmark_symbol=INDEX)
        result, manifest = self.run_strategy(Schedule(), item, events, config, targets=[100, None, 0, -99, 0])
        self.assertEqual(result['status'], 'succeeded', result['message'])
        self.assertEqual([t['net_pnl'] for t in result['trades']], [13, -7])
        self.assertEqual([t['quantity'] for t in result['trades']], [1, 1])
        self.assertEqual(result['metrics']['total_points'], 6)
        self.assertEqual(result['metrics']['max_drawdown_points'], 13)
        self.assertEqual(result['metrics']['average_trade_points'], 3)
        self.assertEqual(result['metrics']['win_rate'], .5)
        self.assertEqual(result['metrics']['benchmark_points'], 20)
        for name in ['total_return', 'annual_return', 'max_drawdown', 'sharpe']:
            self.assertIsNone(result['metrics'][name])
        self.assertEqual(result['monthly_returns'], [{'period': '2026-10', 'return': None, 'pnl': 6}])
        self.assertEqual(result['account']['margin'], 0)
        self.assertEqual(manifest['pnl_unit'], 'points')
        self.assertEqual([s['target'] for s in result['signals']], [1, 0, -1, 0])
        second, _ = self.run_strategy(Schedule(), item, events, replace(config, initial_cash=1e9), targets=[100, None, 0, -99, 0])
        self.assertEqual(result['metrics'], second['metrics'])
        normal, _ = self.run_strategy(Schedule(), item, events, RunConfig(), targets=[100])
        self.assertEqual(normal['status'], 'failed')
        self.assertIn('tradable, actual instrument', normal['message'])

    def test_stop_first_and_slippage_work_without_volume_or_t_plus_one(self):
        item = Instrument(INDEX, 'stock', 1, tradable=False)
        events = [candle(INDEX, 0, 100, volume=0), candle(INDEX, 1, 100, volume=0),
                  candle(INDEX, 2, 100, volume=0)]
        bar = events[2].payload
        events[2] = Event(events[2].id, events[2].available_at, replace(bar, high=112, low=94))
        result, _ = self.run_strategy(Protected(), item, events,
                                     RunConfig(pnl_mode='points', point_cost=.5, slippage_ticks=1))
        self.assertEqual(result['status'], 'succeeded', result['message'])
        trade = result['trades'][0]
        self.assertEqual((trade['entry_price'], trade['exit_price']), (101, 94))
        self.assertEqual(trade['net_pnl'], -8)
        self.assertEqual(trade['exit_reason'], 'stop_loss')

    def test_futures_multiplier_and_overnight_settlement_do_not_change_points(self):
        item = Instrument('TEST', 'future', 1, multiplier=200, margin_rate=.12)
        events = [candle('TEST', 0, 100, volume=0), candle('TEST', 1, 110, volume=0),
                  candle('TEST', 0, 120, day='2026-10-20', offset=86400, volume=0),
                  candle('TEST', 1, 130, day='2026-10-20', offset=86400, volume=0)]
        result, _ = self.run_strategy(Schedule(), item, events, RunConfig(pnl_mode='points', initial_cash=1), targets=[9, None, 0])
        self.assertEqual(result['status'], 'succeeded', result['message'])
        self.assertEqual(result['trades'][0]['net_pnl'], 20)
        self.assertEqual(result['metrics']['total_points'], 20)

    def test_periods_open_position_and_initial_loss_drawdown(self):
        result = summarize_points([
            {'trading_day': '2025-12-31', 'equity': -5, 'benchmark_equity': None},
            {'trading_day': '2026-01-01', 'equity': 3, 'benchmark_equity': None},
        ], [])
        self.assertEqual(result['metrics']['max_drawdown_points'], 5)
        self.assertEqual(result['metrics']['unrealized_points'], 3)
        self.assertEqual([p['pnl'] for p in result['yearly_returns']], [-5, 8])
        self.assertIsNone(result['metrics']['average_trade_points'])

    def test_preparation_preserves_catalog_and_live_index_guard(self):
        raw = prepare_test.PrepareTest().fixture('points')
        raw['config'].update(symbol=INDEX, benchmark_symbol=INDEX)
        raw['instruments'] = {INDEX: {'symbol': INDEX, 'kind': 'stock', 'assetClass': 'index', 'priceTick': .01}}
        for bar in raw['bars']:
            bar['symbol'] = INDEX
        dataset = prepare_test.module.prepare(raw)
        self.assertEqual(raw['instruments'][INDEX]['kind'], 'stock')
        self.assertEqual(dataset.instruments[0].lot_size, 1)
        self.assertTrue(dataset.instruments[0].tradable)
        self.assertEqual(dataset.metadata['execution_model'], 'points')
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, 'Point snapshots require'):
                backtest.run(Strategy(), dataset, output_dir=root)
            with self.assertRaisesRegex(ValueError, 'historical backtests'):
                Runner(Strategy(), dataset.instruments, config=RunConfig(pnl_mode='points'), mode='monitor', output_dir=root)
        raw['config']['execution_model'] = 'actual_contract'
        self.assertFalse(prepare_test.module.prepare(raw).instruments[0].tradable)
        main = prepare_test.module.prepare(prepare_test.PrepareTest().fixture('points'))
        self.assertEqual(main.instruments[0].symbol, prepare_test.MAIN)
        self.assertTrue(all(isinstance(e.payload, Bar) for e in main.events))

    def test_checkpoint_restores_nested_dates_without_marker_collisions(self):
        state = {'position': {'day': date(2026, 10, 19)}, 'datetime': datetime(2026, 10, 19, 9, 30, tzinfo=timezone.utc),
                 'arbitrary': ['date', '2020-01-01'], 'nested': {'type': 'date', 'value': 'unchanged'}}
        self.assertEqual(decode_state(json.loads(json.dumps(encode_state(state)))), state)
        with tempfile.TemporaryDirectory() as root:
            item = Instrument(INDEX, 'stock', .01, tradable=False)
            runner = Runner(Schedule(), [item], config=RunConfig(pnl_mode='points'),
                            params={'symbol': INDEX, 'targets': [100]}, output_dir=root)
            runner.process(candle(INDEX, 0, 100))
            runner.context.state.update(state)
            checkpoint = runner.checkpoint()
            restored = Runner.restore(Schedule(), checkpoint, output_dir=root)
            self.assertEqual(restored.context.state, runner.context.state)
            restored.process(candle(INDEX, 1, 110))
            self.assertEqual(restored.broker.position(INDEX), 1)
            restored.finish()
            runner.finish()


if __name__ == '__main__':
    unittest.main()
