from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Bar, Dataset, Event, Fees, Instrument, LiveRunner, Quote, RiskLevels, RunConfig, Strategy, backtest

START = 1792373400


class ProtectedSchedule(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], 60)

    def on_bar(self, ctx, bar):
        n = ctx.state.get('n', 0)
        ctx.state['n'] = n + 1
        target = ctx.params.get('targets', {'0': 1}).get(str(n))
        if target is not None:
            identity = ctx.orders.target_position(bar.symbol, target, reason='moving_average_cross')
            if target:
                ctx.state['entry'] = identity
        values = ctx.params.get('updates', {}).get(str(n))
        if values is not None:
            values = values if isinstance(values, list) else [values]
            return [RiskLevels(bar.symbol, entry_id=ctx.state['entry'], **value) for value in values]

    def on_fill(self, ctx, fill):
        if fill['offset'] == 'open' and ctx.params.get('from_fill'):
            return RiskLevels(fill['symbol'], stop_loss=105)


class IntrabarUpdate(ProtectedSchedule):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'])

    def on_quote(self, ctx, quote):
        return RiskLevels(quote.symbol, entry_id=ctx.state['entry'], stop_loss=99)


class ProtectiveExecutionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.item = Instrument('CFFEX.IM2612', 'future', .2, multiplier=200, margin_rate=.12,
                               fees=Fees(per_unit=2, close_today_per_unit=5))

    def bar(self, n, *, opening=100, high=102, low=98, close=100, volume=100, next_day=False):
        time = START + n * 60 + (86400 if next_day else 0)
        day = '2026-10-20' if next_day else '2026-10-19'
        return Event(f'bar-{n}', time + 60, Bar(self.item.symbol, time, time + 60, day, 60,
                                               opening, high, low, close, volume))

    def run_case(self, events, *, stop=95, profit=110, targets=None, updates=None, slippage=0, **params):
        self.params = {'symbol': self.item.symbol, 'targets': targets or {'0': 1},
                       'updates': updates if updates is not None else {'0': {'stop_loss': stop, 'take_profit': profit}}, **params}
        self.config = RunConfig(initial_cash=1_000_000, slippage_ticks=slippage)
        result = backtest.run(ProtectedSchedule(), Dataset([self.item], events), params=self.params,
                              config=self.config, output_dir=self.temp.name)
        self.assertEqual(result['status'], 'succeeded', result['message'])
        return result

    def test_long_and_short_stop_target_fills_include_costs_and_causal_time(self):
        for side, stop, profit, low, high, reason, exit_price, gross in [
            (1, 95, 110, 94, 102, 'stop_loss', 94.8, -1080),
            (-1, 105, 90, 98, 106, 'stop_loss', 105.2, -1080),
            (1, 95, 110, 98, 111, 'take_profit', 109.8, 1920),
            (-1, 105, 90, 89, 102, 'take_profit', 90.2, 1920),
        ]:
            with self.subTest(side=side, reason=reason):
                events = [self.bar(0), self.bar(1, low=low, high=high)]
                result = self.run_case(events, stop=stop, profit=profit, targets={'0': side}, slippage=1)
                self.assertEqual(len(result['trades']), 1)
                trade = result['trades'][0]
                self.assertEqual(trade['exit_reason'], reason)
                self.assertEqual(trade['exit_time'], events[1].payload.end_time)
                self.assertEqual(trade['exit_bar_time'], events[1].payload.time)
                self.assertEqual(trade['exit_time_precision'], 'bar')
                self.assertAlmostEqual(trade['exit_price'], exit_price)
                self.assertAlmostEqual(trade['gross_pnl'], gross)
                self.assertAlmostEqual(trade['fees'], 7)
                self.assertAlmostEqual(trade['net_pnl'], gross - 7)
                self.assertEqual(trade['risk_level_id'], result['risk_levels'][0]['id'])
                self.assertEqual(result['fills'][-1]['exit_reason'], reason)
                self.assertTrue(any(s['id'] == trade['exit_signal_id'] and s['kind'] == 'risk_exit' for s in result['signals']))
                self.assertEqual(result['account']['positions'], {})

    def test_gap_prices_and_open_precedence_over_ambiguous_intrabar_extrema(self):
        for opening, low, high, reason in [(90, 88, 92, 'stop_loss'), (115, 94, 116, 'take_profit')]:
            events = [self.bar(0), self.bar(1), self.bar(2, opening=opening, low=low, high=high, close=opening)]
            trade = self.run_case(events, slippage=1)['trades'][0]
            self.assertEqual(trade['exit_reason'], reason)
            self.assertAlmostEqual(trade['exit_price'], opening - .2)
            self.assertEqual(trade['exit_time_precision'], 'open')
            self.assertEqual(trade['exit_time'], events[2].payload.time)

    def test_both_touched_intrabar_chooses_stop_for_both_sides(self):
        for side, stop, profit in [(1, 95, 105), (-1, 105, 95)]:
            result = self.run_case([self.bar(0), self.bar(1, low=94, high=106)], stop=stop,
                                   profit=profit, targets={'0': side})
            self.assertEqual(result['trades'][0]['exit_reason'], 'stop_loss')
            self.assertEqual(result['trades'][0]['exit_price'], stop)

    def test_latest_dynamic_level_only_applies_after_calculation_and_clear_disarms(self):
        events = [self.bar(0), self.bar(1, low=94), self.bar(2)]
        updates = {'0': {'stop_loss': 90}, '1': {'stop_loss': 99}}
        result = self.run_case(events, updates=updates)
        self.assertEqual(result['trades'][0]['exit_bar_time'], events[2].payload.time)
        self.assertEqual(result['trades'][0]['trigger_price'], 99)
        self.assertEqual(result['trades'][0]['risk_level_id'], result['risk_levels'][1]['id'])
        cleared = self.run_case(events, updates={'0': {'stop_loss': 90}, '1': {}})
        self.assertEqual(cleared['trades'], [])
        self.assertEqual(cleared['account']['positions'], {self.item.symbol: 1})

    def test_latest_calculation_at_same_clock_wins(self):
        result = self.run_case([self.bar(0), self.bar(1)], updates={'0': [{'stop_loss': 90}, {'stop_loss': 99}]})
        self.assertEqual(result['trades'][0]['trigger_price'], 99)
        self.assertEqual(result['trades'][0]['risk_level_id'], result['risk_levels'][-1]['id'])

    def test_fill_callback_levels_cannot_trade_the_already_observed_bar(self):
        events = [self.bar(0), self.bar(1), self.bar(2)]
        result = self.run_case(events, updates={}, from_fill=True)
        self.assertEqual(result['trades'][0]['exit_time'], events[2].payload.time)
        self.assertEqual(result['trades'][0]['trigger_price'], 105)

    def test_volume_remainder_stays_pending_and_is_not_rearmed_by_new_levels(self):
        events = [self.bar(0), self.bar(1, volume=3, low=94), self.bar(2, opening=94, close=94, low=93, high=95, volume=1),
                  self.bar(3, opening=93, close=93, low=92, high=94, volume=2), self.bar(4)]
        result = self.run_case(events, targets={'0': 3}, updates={'0': {'stop_loss': 95}, '1': {'stop_loss': 80}})
        self.assertEqual([t['quantity'] for t in result['trades']], [1, 2])
        self.assertEqual([t['exit_price'] for t in result['trades']], [94, 93])
        self.assertTrue(all(t['trigger_price'] == 95 and t['risk_level_id'] == result['risk_levels'][0]['id'] for t in result['trades']))
        self.assertEqual(len([s for s in result['signals'] if s['kind'] == 'risk_exit']), 1)
        self.assertEqual(result['account']['positions'], {})

    def test_partial_entry_remainder_is_cancelled_instead_of_reopening(self):
        events = [self.bar(0), self.bar(1, volume=2, low=94), self.bar(2), self.bar(3)]
        result = self.run_case(events, targets={'0': 3})
        self.assertEqual(result['orders'][0]['status'], 'cancelled')
        self.assertEqual(result['orders'][0]['reason'], 'risk_exit_triggered')
        self.assertEqual(sum(f['quantity'] for f in result['fills'] if f['offset'] == 'open'), 2)
        self.assertEqual(result['account']['positions'], {})

    def test_protection_closes_only_its_entry_when_scaling_in(self):
        result = self.run_case([self.bar(0), self.bar(1), self.bar(2)], targets={'0': 1, '1': 2},
                               updates={'0': {'stop_loss': 90}, '1': {'stop_loss': 99}})
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['entry_signal_id'], result['risk_levels'][1]['entry_signal_id'])
        self.assertEqual(result['account']['positions'], {self.item.symbol: 1})

    def test_stock_t_plus_one_defers_triggered_exit_to_first_eligible_day(self):
        self.item = Instrument('SSE.600000', 'stock', .01)
        events = [self.bar(0), self.bar(1, low=94, volume=1000), self.bar(2, low=94, volume=1000),
                  self.bar(3, next_day=True, opening=90, close=90, low=89, high=91, volume=1000)]
        result = self.run_case(events, targets={'0': 100})
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['exit_time'], events[3].payload.time)
        self.assertEqual(result['trades'][0]['trigger_bar_time'], events[1].payload.time)
        self.assertEqual(result['trades'][0]['exit_price'], 90)

    def test_signal_exit_precedes_later_intrabar_risk_but_gap_risk_cancels_reversal(self):
        events = [self.bar(0), self.bar(1), self.bar(2, low=94)]
        result = self.run_case(events, targets={'0': 1, '1': 0})
        self.assertEqual(result['trades'][0]['exit_reason'], 'moving_average_cross')
        self.assertIsNone(result['trades'][0]['risk_level_id'])
        events[2] = self.bar(2, opening=94, close=94, low=93, high=96)
        result = self.run_case(events, targets={'0': 1, '1': -1})
        self.assertEqual(result['trades'][0]['exit_reason'], 'stop_loss')
        self.assertEqual(result['account']['positions'], {})

    def test_pending_exit_and_latest_levels_survive_restart_and_duplicate_bar(self):
        events = [self.bar(0), self.bar(1, low=94, volume=1), self.bar(2), self.bar(3)]
        expected = self.run_case(events)
        outputs = []
        runner = LiveRunner(ProtectedSchedule(), [self.item], mode='paper', params=self.params, config=self.config,
                            output_dir=self.temp.name, on_event=outputs.append)
        for event in events[:2]: runner.process(event)
        restored = LiveRunner.restore(ProtectedSchedule(), runner.checkpoint(), output_dir=self.temp.name)
        runner.finish('cancelled')
        result = restored.run(events[1:])
        for field in ('risk_levels', 'signals', 'fills', 'trades', 'metrics'):
            self.assertEqual(result[field], expected[field], field)

    def test_monitor_outputs_levels_without_simulated_risk_trades(self):
        events = [self.bar(0), self.bar(1, low=94)]
        self.run_case(events)
        result = LiveRunner(ProtectedSchedule(), [self.item], mode='monitor', params=self.params, config=self.config,
                            output_dir=self.temp.name).run(events)
        self.assertEqual(result['trades'], [])
        self.assertEqual(len(result['risk_levels']), 1)

    def test_intrabar_quote_update_does_not_apply_to_earlier_extrema(self):
        time = START + 90
        events = [self.bar(0), Event('quote-update', time, Quote(self.item.symbol, time, '2026-10-19', last=100)),
                  self.bar(1, low=94), self.bar(2)]
        params = {'symbol': self.item.symbol, 'updates': {'0': {'stop_loss': 90}}}
        result = backtest.run(IntrabarUpdate(), Dataset([self.item], events), params=params, output_dir=self.temp.name)
        self.assertEqual(result['status'], 'succeeded', result['message'])
        self.assertEqual(result['trades'][0]['exit_bar_time'], events[-1].payload.time)
        self.assertEqual(result['trades'][0]['trigger_price'], 99)


if __name__ == '__main__': unittest.main()
