import asyncio
import sys
import unittest
from datetime import datetime
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
    def test_closed_bars_resume_independent_periods_and_skip_unfinished_tail(self):
        previous = 3600
        symbol = 'CFFEX.MO2612-C-6800'
        targets = [dict(symbol=symbol, latest={'60': previous})]
        lengths = []
        def serial(loaded_symbol, duration, data_length):
            self.assertEqual(loaded_symbol, symbol)
            lengths.append(data_length)
            if duration == 300:
                return bars([3000, 3300, 3600])
            return bars([previous, previous + duration, previous + duration * 2])

        def create_task(coro):
            asyncio.run(coro)
            return SimpleNamespace(done=lambda: True)

        api = SimpleNamespace(create_task=create_task, get_kline_serial=serial, is_serial_ready=lambda _: True)
        events = []
        with patch.object(archive, 'DURATIONS', (60, 300)), \
             patch.object(archive.time, 'time', return_value=previous + 122), \
             patch.object(archive, 'emit', lambda kind, **payload: events.append((kind, payload))):
            archive.collect(api, targets, 100)
        self.assertEqual(lengths, [5, 100])
        self.assertEqual([v['time'] for v in events[0][1]['bars']], [previous + 60])
        self.assertEqual(events[-1][1]['result']['latest'], {'60': 3660, '300': 3300})
        self.assertEqual(events[-1][1]['result']['outcome'], 'ready')
        self.assertEqual((events[-1][1]['result']['firstBarAt'], events[-1][1]['result']['lastBarAt']), (3660, 3660))

    def test_friday_night_daily_candle_closes_after_monday_session(self):
        def local(text):
            return datetime.fromisoformat(text).replace(tzinfo=archive.TZ).timestamp()
        start = local('2026-11-20T18:00:00')
        api = SimpleNamespace(get_trading_calendar=lambda *_: pd.DataFrame([
            {'date': pd.Timestamp('2026-11-20'), 'trading': True},
            {'date': pd.Timestamp('2026-11-23'), 'trading': True},
        ]))
        calendar = archive.TickCalendar(api)
        self.assertFalse(archive.latest_is_closed(start, 86400, local('2026-11-22T18:01:00'), calendar))
        self.assertTrue(archive.latest_is_closed(start, 86400, local('2026-11-23T16:01:00'), calendar))

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
        targets = [dict(symbol=name, latest={}) for name in ['MISSING', 'EMPTY']]
        with patch.object(archive, 'emit', lambda kind, **payload: events.append(payload['result'])):
            archive.collect(api, targets, 100)
        self.assertEqual([(result['symbol'], result['outcome']) for result in events], [('MISSING', 'error'), ('EMPTY', 'empty')])
