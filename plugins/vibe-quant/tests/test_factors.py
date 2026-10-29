import contextlib
from dataclasses import replace
from datetime import datetime, timedelta
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk'))
sys.path.insert(0, str(ROOT / 'worker'))
from quant_sdk import Bar, DataView, Event, Factor, Instrument, load_factor
from quant_sdk.factors import factor_from_source
from factor_analysis import analyze, correlation, ranks, performance


class Momentum(Factor):
    def lookback(self, params):
        return params.get('window', 2)

    def compute(self, bars, params):
        return bars[-1].close / bars[0].close - 1


def fixture():
    symbols = [f'SHFE.x{i}2601' for i in range(6)]
    bars = []
    day = datetime(2026, 1, 5, 1)
    for i in range(65):
        while day.weekday() > 4:
            day += timedelta(days=1)
        for j, symbol in enumerate(symbols):
            price = 100 * (1 + .001 * (j+1))**i
            bars.append(Bar(symbol, day.timestamp(), day.timestamp()+6*3600, day.date().isoformat(),
                            86400, price, price*1.01, price*.99, price, 100))
        day += timedelta(days=1)
    config = dict(symbols=symbols, start=bars[6].trading_day, end=bars[-1].trading_day,
                  holding_days=5, groups=3, direction=1)
    return bars, config


class FactorsTest(unittest.TestCase):
    def test_pure_formula_and_closed_history_match_strategy(self):
        bars, config = fixture()
        instrument = Instrument(config['symbols'][0], 'future', .1, multiplier=10, margin_rate=.1)
        data = DataView([instrument])
        factor = Momentum()
        history = [bar for bar in bars if bar.symbol == instrument.symbol][:5]
        for bar in history:
            data._apply(Event(f'bar-{bar.time}', bar.end_time, bar))
        ctx = SimpleNamespace(data=data)
        self.assertAlmostEqual(factor.value(ctx, instrument.symbol), factor.evaluate(history))
        future = replace(history[-1], time=history[-1].time+86400, end_time=history[-1].end_time+86400, close=999, high=999, is_final=False)
        self.assertEqual(factor.evaluate([*history, future]), factor.evaluate(history))
        self.assertIsNone(factor.evaluate(history[:1]))

    def test_invalid_outputs_and_window_fail_loudly(self):
        bars, _ = fixture()
        sample = [bar for bar in bars if bar.symbol == bars[0].symbol][:2]
        class Bad(Momentum):
            def compute(self, bars, params): return float('nan')
        with self.assertRaisesRegex(ValueError, 'NaN'):
            Bad().evaluate(sample)
        with self.assertRaisesRegex(ValueError, 'lookback'):
            Momentum().evaluate(sample, {'window': 501})
        with self.assertRaisesRegex(ValueError, '同一合约'):
            Momentum().evaluate(bars[:2])

    def test_entrypoint_requires_unique_concrete_factor(self):
        source = (ROOT/'sdk/templates/factor.py').read_text()
        factor = factor_from_source(source)
        self.assertEqual(factor.lookback({}), 20)
        with self.assertRaisesRegex(ValueError, '一个具体'):
            factor_from_source(source + '\nclass Another(Factor):\n    def compute(self, bars, params): return 1\n')
        with self.assertRaisesRegex(ValueError, 'compute'):
            factor_from_source('from quant_sdk import Factor\nclass Missing(Factor): pass')

    def test_published_version_defaults_and_hash(self):
        version = str(uuid4())
        source = (ROOT/'sdk/templates/factor.py').read_text()
        original = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                row = dict(source=source, source_hash=sha256(source.encode()).hexdigest(), parameters={'window': 3})
                Path('factor-library.json').write_text(json.dumps({version: row}))
                factor = load_factor(version)
                self.assertEqual(factor.lookback({}), 3)
                self.assertEqual(factor.lookback({'window': 5}), 5)
                row['source'] += '\n# modified'
                Path('factor-library.json').write_text(json.dumps({version: row}))
                with self.assertRaisesRegex(ValueError, '校验'):
                    load_factor(version)
            finally:
                os.chdir(original)

    def test_analysis_forward_alignment_direction_and_compounding(self):
        bars, config = fixture()
        report = analyze(Momentum(), bars, config, {})
        self.assertGreater(report['metrics']['rank_ic_mean'], .99)
        self.assertGreater(report['groups'][-1]['total_return'], 0)
        self.assertEqual(report['curve'][-1]['values'][-1], report['groups'][-1]['total_return'])
        reverse = analyze(Momentum(), bars, {**config, 'direction': -1}, {})
        self.assertLess(reverse['metrics']['rank_ic_mean'], -.99)
        self.assertLess(reverse['groups'][-1]['total_return'], 0)
        self.assertEqual(report['latest'], reverse['latest'])
        # First holding interval: signal day index 1, entry index 2, exit index 7.
        first_group_return = ((1.001**5-1)+(1.002**5-1))/2
        self.assertAlmostEqual(report['curve'][1]['values'][0], first_group_return)

    def test_compute_never_receives_future_rows(self):
        bars, config = fixture()
        seen = []
        class Observed(Momentum):
            def evaluate_panel(self, *_):
                raise AssertionError('ordinary factors must not receive future snapshots')

            def compute(self, history, params):
                self.assertion = all(a.end_time < b.end_time for a, b in zip(history, history[1:]))
                seen.append((history[-1].symbol, history[-1].trading_day, tuple(b.close for b in history)))
                return super().compute(history, params)
        analyze(Observed(), bars, config, {})
        original = list(seen)
        seen.clear()
        changed = [replace(b, close=b.close*2, high=b.high*2) if b.trading_day == config['end'] else b for b in bars]
        analyze(Observed(), changed, config, {})
        self.assertEqual([s for s in original if s[1] != config['end']], [s for s in seen if s[1] != config['end']])
        self.assertTrue(all(len(s[2]) == 2 for s in seen))

    def test_missing_future_asset_skips_whole_period(self):
        bars, config = fixture()
        original = analyze(Momentum(), bars, config, {})
        missing_day = bars[6*5].trading_day
        incomplete = [b for b in bars if not (b.symbol == config['symbols'][0] and b.trading_day == missing_day)]
        result = analyze(Momentum(), incomplete, config, {})
        self.assertLess(result['metrics']['periods'], original['metrics']['periods'])
        self.assertTrue(any('跳过' in warning for warning in result['warnings']))

    def test_constant_factor_is_not_a_fake_portfolio(self):
        bars, config = fixture()
        class Constant(Momentum):
            def compute(self, history, params): return 1
        with self.assertRaisesRegex(ValueError, '因子值相同'):
            analyze(Constant(), bars, config, {})
        self.assertEqual(ranks([2, 1, 2, 4]), [1.5, 0, 1.5, 3])
        self.assertIsNone(correlation([1, 1, 1], [1, 2, 3]))
        self.assertIsNone(performance([.01, .01+1e-16, .01], 5)['sharpe'])


if __name__ == '__main__':
    unittest.main()
