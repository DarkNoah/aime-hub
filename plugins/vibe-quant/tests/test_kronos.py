from dataclasses import replace
from datetime import datetime
from pathlib import Path
import sys
from threading import Event
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Bar, DataView, Event as MarketEvent, Instrument, KronosFactor, kronos_forecast
from quant_sdk.kronos import KronosCancelled, _future_times, _RESULTS, summarize_paths
from types import SimpleNamespace


def bars():
    start = datetime.fromisoformat('2026-10-28T10:00:00+08:00').timestamp()
    return [Bar('CFFEX.IM2612', start+i*60, start+(i+1)*60, '2026-10-28',
                60, 100, 102, 98, 100, 100) for i in range(4)]


class KronosTests(unittest.TestCase):
    def setUp(self):
        _RESULTS.clear()
        self.bundle = patch('quant_sdk.kronos._bundle', return_value=(None, {'max_context': 512}, 'weights-v1'))
        self.sample = patch('quant_sdk.kronos._sample_paths', return_value=[[101, 110], [99, 90], [100, 100], [100, 104]])
        self.bundle.start()
        self.infer = self.sample.start()
        self.addCleanup(self.bundle.stop)
        self.addCleanup(self.sample.stop)

    def test_sample_frequencies_not_mean_or_candle_color(self):
        result = summarize_paths([[1000, 110], [1000, 90], [1000, 100], [1000, 104]], 100, flat_return=.05)
        self.assertEqual(result['bullish_probability'], .25)
        self.assertEqual(result['bearish_probability'], .25)
        self.assertEqual(result['neutral_probability'], .5)
        self.assertAlmostEqual(result['expected_return'], .01)
        self.assertAlmostEqual(result['return_p50'], .02)
        self.assertEqual(result['mean_close_path'], (1000, 101))

    def test_unclosed_rows_do_not_change_result_or_seed(self):
        history = bars()
        result = kronos_forecast(history, lookback=4, horizon=2, samples=4)
        future = replace(history[-1], time=history[-1].end_time, end_time=history[-1].end_time+60,
                         high=1000, close=1000, is_final=False)
        self.assertEqual(kronos_forecast(history+[future], lookback=4, horizon=2, samples=4), result)
        self.infer.assert_called_once()
        self.assertEqual(self.infer.call_args.args[2], tuple(history))

    def test_cache_includes_corrections_parameters_and_weights(self):
        history = bars()
        first = kronos_forecast(history, lookback=4, horizon=2, samples=4)
        changed = [replace(history[0], close=101), *history[1:]]
        second = kronos_forecast(changed, lookback=4, horizon=2, samples=4)
        self.assertNotEqual(first.seed, second.seed)
        third = kronos_forecast(history, lookback=4, horizon=2, samples=4, seed=17)
        self.assertNotEqual(first.seed, third.seed)
        with patch('quant_sdk.kronos._bundle', return_value=(None, {'max_context':512}, 'weights-v2')):
            fourth = kronos_forecast(history, lookback=4, horizon=2, samples=4)
        self.assertNotEqual(first.model_fingerprint, fourth.model_fingerprint)
        self.assertEqual(self.infer.call_count, 4)

    def test_warmup_and_causal_context_factor(self):
        history = bars()
        instrument = Instrument(history[0].symbol, 'future', .2, multiplier=200, margin_rate=.12)
        data = DataView([instrument])
        factor = KronosFactor()
        self.assertIsNone(factor.evaluate(history[:3], {'lookback':4}))
        for i, bar in enumerate(history):
            data._apply(MarketEvent(str(i), bar.end_time, bar))
        self.assertEqual(factor.value(SimpleNamespace(data=data), instrument.symbol, 60,
                                      lookback=4, horizon=2, samples=4), .5)

    def test_lunch_and_end_of_day_are_not_continuous_wall_time(self):
        bar = bars()[-1]
        at = lambda clock: datetime.fromisoformat('2026-10-28T'+clock+'+08:00').timestamp()
        last = replace(bar, time=at('11:29:00'), end_time=at('11:30:00'))
        self.assertEqual(_future_times(last, 2), (at('13:00:00'), at('13:01:00')))
        last = replace(bar, time=at('14:59:00'), end_time=at('15:00:00'))
        self.assertIsNone(_future_times(last, 2))
        with self.assertRaisesRegex(ValueError, 'exchange calendar'):
            _future_times(replace(bar, symbol='SHFE.rb2612'), 2)

    def test_validation_and_abort_never_become_neutral_forecasts(self):
        history = bars()
        for options in ({'samples':1}, {'horizon':0}, {'flat_return':-1}, {'top_p':0},
                        {'temperature':float('nan')}, {'future_times':[history[-1].time]}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                kronos_forecast(history, lookback=4, **options)
        with self.assertRaisesRegex(ValueError, 'chronological'):
            kronos_forecast(history[::-1], lookback=4)
        with self.assertRaisesRegex(ValueError, 'one symbol'):
            kronos_forecast([*history[:-1], replace(history[-1], symbol='other')], lookback=4)
        stop = Event()
        stop.set()
        with self.assertRaisesRegex(KronosCancelled, '用户中止'):
            kronos_forecast(history, lookback=4, stop_event=stop)
        self.infer.assert_not_called()

    def test_bad_model_outputs_fail(self):
        for paths in ([[100]], [[float('nan')], [100]], [[0], [100]], [[100], [100, 101]]):
            with self.subTest(paths=paths), self.assertRaises(ValueError):
                summarize_paths(paths, 100)
        self.infer.return_value = [[100, 101]]
        with self.assertRaisesRegex(ValueError, 'sample shape'):
            kronos_forecast(bars(), lookback=4, horizon=2, samples=4)


if __name__ == '__main__':
    unittest.main()
