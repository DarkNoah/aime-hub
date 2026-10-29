"""Opt in with QUANT_KRONOS_ROOT and requirements-kronos.txt installed."""
from datetime import datetime
import importlib.util
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Bar, kronos_forecast
from quant_sdk.kronos import KronosCancelled, _RESULTS


@unittest.skipUnless(os.environ.get('QUANT_KRONOS_ROOT') and importlib.util.find_spec('torch'),
                     'Optional real Kronos bundle not configured')
class RealKronosTests(unittest.TestCase):
    def test_real_paths_reproduce_without_cache_and_cancel_inside_generation(self):
        import torch
        torch.set_num_threads(2)
        start = datetime.fromisoformat('2026-10-28T10:00:00+08:00').timestamp()
        history = [Bar('CFFEX.IM2612', start+i*60, start+(i+1)*60, '2026-10-28', 60,
                       6000+i*.2, 6001+i*.2, 5999+i*.2, 6000.5+i*.2, 100+i) for i in range(32)]
        device = os.environ.get('QUANT_KRONOS_TEST_DEVICE', 'cpu')
        options = dict(lookback=32, horizon=3, samples=8, seed=19, device=device)
        first = kronos_forecast(history, **options)
        _RESULTS.clear()
        rng = torch.random.get_rng_state().clone()
        mps_rng = torch.mps.get_rng_state().clone() if device == 'mps' else None
        second = kronos_forecast(history, **options)
        self.assertEqual(first, second)
        self.assertTrue(torch.equal(rng, torch.random.get_rng_state()))
        if mps_rng is not None:
            self.assertTrue(torch.equal(mps_rng, torch.mps.get_rng_state()))
        self.assertAlmostEqual(first.bullish_probability + first.bearish_probability + first.neutral_probability, 1)
        self.assertEqual(len(first.mean_close_path), 3)
        self.assertEqual(first.sample_count, 8)
        self.assertEqual(first.bullish_probability * 8, int(first.bullish_probability * 8))
        class StopDuringGeneration:
            calls = 0
            def is_set(self):
                self.calls += 1
                return self.calls >= 4
        _RESULTS.clear()
        stop = StopDuringGeneration()
        with self.assertRaisesRegex(KronosCancelled, '用户中止'):
            kronos_forecast(history, stop_event=stop, **options)
        self.assertGreaterEqual(stop.calls, 4)
        self.assertEqual(kronos_forecast(history, **options), first)


if __name__ == '__main__':
    unittest.main()
