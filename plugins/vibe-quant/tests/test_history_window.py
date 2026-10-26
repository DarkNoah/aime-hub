from collections import OrderedDict
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Bar, Instrument
from quant_sdk.data import DataView


class HistoryWindowTest(unittest.TestCase):
    def test_tail_matches_full_filter_for_partial_bars_and_as_of(self):
        view = DataView([Instrument('TEST', 'future', price_tick=1, multiplier=1, margin_rate=1)])
        bars = [Bar('TEST', i * 60, (i + 1) * 60, '2026-10-22', 60,
                    100, 101, 99, 100, 10, is_final=i % 7 != 0)
                for i in range(200)]
        view._bars[('TEST', 60)] = OrderedDict((b.time, b) for b in bars)
        view.now = 12000
        for end in (0, 60, 630, 4800, 12000):
            for count in (1, 3, 50, 1000):
                expected = tuple(b for b in bars if b.is_final and b.end_time <= end)[-count:]
                self.assertEqual(view.history('TEST', 60, count, as_of=end), expected)
        self.assertEqual(view.history('TEST', 300), ())
        with self.assertRaises(ValueError):
            view.history('TEST', 60, as_of=view.now + 1)


if __name__ == '__main__':
    unittest.main()
