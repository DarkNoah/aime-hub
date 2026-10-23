import importlib.util
import json
from dataclasses import replace
from datetime import date, datetime, timedelta
from pathlib import Path
import sys
import tempfile
import unittest
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Bar, Dataset, Event, Instrument, LiveRunner, Roll, RunConfig, backtest

spec = importlib.util.spec_from_file_location('orb_example', Path(__file__).resolve().parents[1] / 'sdk/examples/orb_v2.py')
orb = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = orb
spec.loader.exec_module(orb)
MAIN, ACTUAL = 'KQ.m@CFFEX.IM', 'CFFEX.IM2611'
ZONE = ZoneInfo('Asia/Shanghai')
DEFAULT_PARAMETERS = json.loads((Path(__file__).resolve().parents[1] / 'sdk/examples/orb_v2.parameters.json').read_text())


def stamp(day, minute):
    return datetime.fromisoformat(day).replace(tzinfo=ZONE).timestamp() + minute * 60


def event(symbol, day, minute, prices):
    end = stamp(day, minute)
    bar = Bar(symbol, end - 60, end, day, 60, *prices, 1000)
    return Event(f'{symbol}:{end}', end, bar)


class OrbTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        first = date(2026, 8, 3)
        self.calendar = {(first + timedelta(days=n)).isoformat(): (first + timedelta(days=n)).weekday() < 5 for n in range(45)}
        days = [day for day, opened in self.calendar.items() if opened]
        self.prior, self.day = days[:14], days[14]
        self.items = [Instrument(MAIN, 'continuous', .2),
                      Instrument(ACTUAL, 'future', .2, multiplier=200, margin_rate=.12)]
        self.params = {**DEFAULT_PARAMETERS, 'symbol': MAIN, 'trading_calendar': self.calendar}
        self.config = RunConfig(initial_cash=1_000_000, start=stamp(self.day, 570), checkpoint_interval=86400)

    def history(self, omitted=None):
        return [event(MAIN, day, minute, (110, 120, 100, 110))
                for day in self.prior if day != omitted for minute in orb.MINUTES]

    def active(self, direction=1, last=591, overrides=None, missing=None, actual=True):
        events = [Event('roll', stamp(self.day, 570), Roll(MAIN, ACTUAL, stamp(self.day, 570), self.day))]
        for minute in orb.MINUTES:
            if minute > last or minute == missing:
                continue
            prices = (110, 120, 100, 110) if minute <= 585 else (
                (121, 122, 120.2, 121) if direction > 0 else (99, 99.8, 98, 99))
            real = tuple(value + 10 for value in prices)
            if overrides and minute in overrides:
                real = overrides[minute]
            if actual:
                events.append(event(ACTUAL, self.day, minute, real))
            events.append(event(MAIN, self.day, minute, prices))
        return events

    def run_orb(self, active=None, history=None, mode=None, params=None):
        events = (self.history() if history is None else history) + (self.active() if active is None else active)
        kwargs = dict(params=self.params if params is None else params, config=self.config, output_dir=self.temp.name)
        if mode:
            return LiveRunner(orb.OpeningRangeBreakoutV2(), self.items, mode=mode, **kwargs).run(events)
        return backtest.run(orb.OpeningRangeBreakoutV2(), Dataset(self.items, events), **kwargs)

    def assertSuccess(self, result):
        self.assertEqual(result['status'], 'succeeded', result['message'])

    def test_long_short_signals_and_actual_price_coordinates(self):
        for side in (1, -1):
            active = self.active(side, overrides={587: (131.2, 132, 130.2, 131.2) if side > 0 else (108.8, 109.8, 108, 108.8)})
            result = self.run_orb(active)
            self.assertSuccess(result)
            signals = [s for s in result['signals'] if s['kind'] == 'orb_breakout']
            self.assertEqual(len(signals), 1)
            self.assertEqual(signals[0]['source_symbol'], MAIN)
            self.assertEqual(signals[0]['symbol'], ACTUAL)
            self.assertEqual(signals[0]['time'], stamp(self.day, 586))
            self.assertEqual(result['fills'][0]['symbol'], ACTUAL)
            self.assertEqual(result['fills'][0]['time'], stamp(self.day, 586))
            self.assertEqual(result['risk_levels'][0]['stop_loss'], 110 if side > 0 else 130)
            self.assertAlmostEqual(result['risk_levels'][1]['take_profit'], 163 if side > 0 else 77)

    def test_target_exit_and_only_one_entry_per_day(self):
        result = self.run_orb(self.active(overrides={588: (132, 164, 130, 133)}))
        self.assertSuccess(result)
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['exit_reason'], 'take_profit')
        self.assertAlmostEqual(result['trades'][0]['exit_price'], 162.6)
        self.assertEqual(len([s for s in result['signals'] if s['kind'] == 'orb_breakout']), 1)

    def test_protection_only_applies_to_next_complete_bar(self):
        result = self.run_orb(self.active(overrides={588: (131, 153, 130, 145), 589: (145, 146, 139, 140)}))
        self.assertSuccess(result)
        self.assertEqual(len(result['trades']), 1)
        trade = result['trades'][0]
        self.assertEqual(trade['exit_reason'], 'stop_loss')
        self.assertEqual(trade['exit_price'], 141)
        self.assertEqual(trade['exit_bar_time'], stamp(self.day, 588))
        self.assertEqual(result['risk_levels'][-1]['time'], stamp(self.day, 588))

    def test_incomplete_or_absent_expected_day_blocks_entry(self):
        histories = [self.history(omitted=self.prior[5]), self.history()[:-1]]
        for history in histories:
            result = self.run_orb(history=history)
            self.assertSuccess(result)
            self.assertEqual(result['orders'], [])

    def test_current_gap_or_missing_execution_data_blocks_entry(self):
        for active in (self.active(missing=580), self.active(actual=False)):
            result = self.run_orb(active)
            self.assertSuccess(result)
            self.assertEqual(result['orders'], [])

    def test_narrow_range_blocks_entry(self):
        history = [event(MAIN, day, minute, (110, 130, 90, 110)) for day in self.prior for minute in orb.MINUTES]
        result = self.run_orb(history=history)
        self.assertSuccess(result)
        self.assertEqual(result['orders'], [])

    def test_deadline_closes_at_next_available_open(self):
        result = self.run_orb(self.active(last=886))
        self.assertSuccess(result)
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['exit_reason'], 'orb_14_45')
        self.assertEqual(result['trades'][0]['exit_time'], stamp(self.day, 885))

    def test_custom_deadline_and_quantity_are_applied(self):
        result = self.run_orb(self.active(last=600), params={**self.params, 'deadline': '09:50', 'quantity': 2})
        self.assertSuccess(result)
        self.assertEqual(result['trades'][0]['exit_time'], stamp(self.day, 590))
        self.assertEqual(result['trades'][0]['exit_reason'], 'orb_09_50')
        self.assertEqual(result['trades'][0]['quantity'], 2)
        self.assertEqual(len([s for s in result['signals'] if s['kind'] == 'orb_breakout']), 1)

    def test_custom_daily_entry_limit(self):
        active = self.active(last=595, overrides={588: (132, 164, 130, 133), 591: (132, 164, 130, 133)})
        result = self.run_orb(active, params={**self.params, 'max_entries_per_day': 2})
        self.assertSuccess(result)
        self.assertEqual(len(result['trades']), 2)
        self.assertEqual(len([s for s in result['signals'] if s['kind'] == 'orb_breakout']), 2)

    def test_custom_protection_trigger_and_lock_points(self):
        active = self.active(overrides={588: (131, 143, 130, 140), 589: (140, 141, 135, 136)})
        result = self.run_orb(active, params={**self.params, 'protection_trigger_r': .5, 'protection_points': 5})
        self.assertSuccess(result)
        self.assertEqual(result['trades'][0]['exit_price'], 136)
        self.assertEqual(result['trades'][0]['exit_reason'], 'stop_loss')
        self.assertEqual(self.run_orb(active)['trades'], [])

    def test_custom_lookback_multiplier_and_reward(self):
        history = self.history(omitted=self.prior[0])
        self.assertEqual(self.run_orb(history=history)['orders'], [])
        result = self.run_orb(history=history, params={**self.params, 'lookback': 10, 'reward_risk_ratio': 2})
        self.assertSuccess(result)
        self.assertEqual(result['risk_levels'][1]['take_profit'], 173)
        blocked = self.run_orb(params={**self.params, 'multiplier': 1.1})
        self.assertSuccess(blocked)
        self.assertEqual(blocked['orders'], [])

    def test_custom_range_changes_entry_time(self):
        active = self.active(last=600)
        active = [replace(e, payload=replace(e.payload, open=140, high=141, low=139, close=140))
                  if isinstance(e.payload, Bar) and e.payload.end_time >= stamp(self.day, 591) else e
                  for e in active]
        result = self.run_orb(active, params={**self.params, 'range_minutes': 20})
        self.assertSuccess(result)
        self.assertEqual(result['signals'][0]['time'], stamp(self.day, 591))

    def test_tuning_parameters_cannot_silently_fall_back(self):
        for key in DEFAULT_PARAMETERS:
            params = {k: v for k, v in self.params.items() if k != key}
            result = self.run_orb(params=params)
            self.assertEqual(result['status'], 'failed', key)
            self.assertIn(key, result['message'])
        for patch in ({'deadline': '15:00'}, {'deadline': '11:30'}, {'deadline': '12:30'},
                      {'deadline': '09:46'}, {'deadline': '14:99'}, {'max_entries_per_day': 0},
                      {'protection_trigger_r': False}, {'protection_points': 10.1}):
            self.assertEqual(self.run_orb(params={**self.params, **patch})['status'], 'failed', patch)

    def test_paper_replay_matches_and_monitor_never_orders(self):
        active = self.active(overrides={588: (132, 164, 130, 133)})
        result = self.run_orb(active)
        paper = self.run_orb(active, mode='paper')
        monitor = self.run_orb(active, mode='monitor')
        for run in (result, paper, monitor):
            self.assertSuccess(run)
        for key in ('signals', 'fills', 'trades', 'risk_levels'):
            self.assertEqual(result[key], paper[key])
        self.assertEqual(monitor['orders'], [])
        self.assertEqual(monitor['fills'], [])
        self.assertTrue(any(s['kind'] == 'orb_breakout' for s in monitor['signals']))

    def test_rejects_wrong_symbol_or_period(self):
        for patch in ({'symbol': ACTUAL}, {'duration': 300}):
            result = self.run_orb(params={**self.params, **patch})
            self.assertEqual(result['status'], 'failed')

    def test_explicit_continuous_price_backtest_and_live_rejection(self):
        self.items = [Instrument(MAIN, 'future', .2, multiplier=200, margin_rate=.12)]
        active = [e for e in self.active(last=886, actual=False) if isinstance(e.payload, Bar)]
        params = {**self.params, 'execution_model': 'continuous_price'}
        result = self.run_orb(active, params=params)
        self.assertSuccess(result)
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['symbol'], MAIN)
        self.assertEqual(result['trades'][0]['entry_price'], 121)
        self.assertEqual(result['risk_levels'][0]['stop_loss'], 100)
        self.assertEqual(result['trades'][0]['exit_reason'], 'orb_14_45')
        # A synthetic future must never silently activate in the default mode
        # or be used by the same strategy in paper/monitor operation.
        self.assertEqual(self.run_orb(active)['status'], 'failed')
        for mode in ('paper', 'monitor'):
            self.assertEqual(self.run_orb(active, params=params, mode=mode)['status'], 'failed')

    def test_entry_uses_mapping_observed_before_signal(self):
        other = 'CFFEX.IM2612'
        self.items.append(Instrument(other, 'future', .2, multiplier=200, margin_rate=.12))
        active = self.active()
        active = [Event(e.id + ':new', e.available_at, replace(e.payload, symbol=other))
                  if isinstance(e.payload, Bar) and e.payload.symbol == ACTUAL else e for e in active]
        changed = stamp(self.day, 585) + .5
        active.append(Event('new-main', changed, Roll(MAIN, other, changed, self.day)))
        result = self.run_orb(sorted(active, key=lambda e: e.available_at))
        self.assertSuccess(result)
        self.assertEqual(result['fills'][0]['symbol'], other)
        self.assertTrue(all(fill['symbol'] != ACTUAL for fill in result['fills']))

    def test_checkpoint_restores_open_trade_and_daily_limit(self):
        active = self.active(overrides={588: (132, 164, 130, 133)})
        events = self.history() + active
        kwargs = dict(params=self.params, config=self.config, output_dir=self.temp.name, mode='paper')
        runner = LiveRunner(orb.OpeningRangeBreakoutV2(), self.items, **kwargs)
        split = next(i for i, e in enumerate(events) if e.available_at > stamp(self.day, 587))
        for e in events[:split]:
            runner.process(e)
        checkpoint = runner.checkpoint()
        restored = LiveRunner.restore(orb.OpeningRangeBreakoutV2(), checkpoint, output_dir=self.temp.name)
        runner.finish('cancelled')
        result = restored.run(events[split:])
        full = self.run_orb(active)
        self.assertSuccess(result)
        for key in ('signals', 'fills', 'trades', 'risk_levels'):
            self.assertEqual(result[key], full[key])


if __name__ == '__main__':
    unittest.main()
