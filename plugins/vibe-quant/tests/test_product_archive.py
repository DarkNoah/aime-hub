import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
import product_archive as archive


def bars(times):
    return pd.DataFrame([dict(id=i, datetime=t * 1_000_000_000,
                              open=4, high=5, low=3, close=4, volume=2)
                         for i, t in enumerate(times)])


class ProductArchiveTest(unittest.TestCase):
    def test_requests_only_minutes_and_resumes_existing_minute_checkpoint(self):
        previous = 3600
        option = 'CFFEX.MO2612-C-6800'
        future = 'CFFEX.IM2612'
        # Persisted progress from the multi-period archive may lack a minute cursor.
        targets = [dict(symbol=option, latest={'60': previous, '300': 3300}),
                   dict(symbol=future, latest={'300': 3300})]
        requests = []
        def serial(symbol, duration, data_length):
            requests.append((symbol, duration, data_length))
            return bars([previous, previous + 60, previous + 120])

        def create_task(coro):
            asyncio.run(coro)
            return SimpleNamespace(done=lambda: True)

        api = SimpleNamespace(create_task=create_task, get_kline_serial=serial, is_serial_ready=lambda _: True)
        events = []
        with patch.object(archive.time, 'time', return_value=previous + 120), \
             patch.object(archive, 'emit', lambda kind, **payload: events.append((kind, payload))):
            archive.collect(api, targets, 100)
        self.assertEqual(requests, [(option, 60, 4), (future, 60, 100)])
        emitted = [row for kind, payload in events if kind == 'bars' for row in payload['bars']]
        self.assertEqual([(row['symbol'], row['duration'], row['time']) for row in emitted],
                         [(option, 60, 3660), (future, 60, 3600), (future, 60, 3660)])
        results = [payload['result'] for kind, payload in events if kind == 'result']
        self.assertEqual(results, [
            dict(symbol=option, latest={'60': 3660}, outcome='ready', firstBarAt=3660, lastBarAt=3660),
            dict(symbol=future, latest={'60': 3660}, outcome='ready', firstBarAt=3600, lastBarAt=3660),
        ])

    def test_minute_window_stays_bounded_after_downtime(self):
        self.assertEqual(archive.window_size(60, 86400 * 7, 100), 100)

    def test_failed_contract_and_empty_contract_remain_retryable(self):
        def serial(symbol, duration, data_length):
            if symbol == 'MISSING':
                raise RuntimeError('unavailable')
            return bars([0])
        def task(coro):
            asyncio.run(coro)
            return SimpleNamespace(done=lambda: True)
        api = SimpleNamespace(create_task=task, get_kline_serial=serial, is_serial_ready=lambda _: True)
        events = []
        targets = [dict(symbol='MISSING', latest={'60': 600}),
                   dict(symbol='EMPTY', latest={'86400': 86400})]
        with patch.object(archive, 'emit', lambda kind, **payload: events.append(payload['result'])):
            archive.collect(api, targets, 100)
        self.assertEqual([(result['symbol'], result['outcome']) for result in events], [('MISSING', 'error'), ('EMPTY', 'empty')])
        self.assertEqual([result['latest'] for result in events], [{'60': 600}, {}])
