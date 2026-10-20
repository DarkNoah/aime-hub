import json
import sys
import unittest
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
from common import TZ
from ticks import TickCalendar, TickCollector, normalize_tick, tick_targets
import tq_provider


def ns(text):
    return int(datetime.fromisoformat(text).replace(tzinfo=TZ).timestamp()) * 1_000_000_000


def rows(ids=(100, 101, 102), volumes=(0, 2, 5)):
    return pd.DataFrame([
        dict(id=i, datetime=ns('2026-10-19T09:30:00') + (i - 100) * 1_000_000_000 + 123,
             last_price=8000, volume=v, amount=v * 8000 * 200,
             bid_price1=7999.8, ask_price1=8000.2)
        for i, v in zip(ids, volumes)
    ])


class Row(dict):
    __getattr__ = dict.__getitem__


META = Row(ins_class='FUTURE', underlying_symbol='', price_tick=0.2, volume_multiple=200)


class Api:
    def __init__(self):
        self.frame = rows()
        self.subscriptions = []
        self.changed = True

    def get_tick_serial(self, symbol, data_length):
        self.subscriptions.append((symbol, data_length))
        return self.frame

    def is_serial_ready(self, frame):
        return True

    def is_changing(self, frame):
        return self.changed

    def get_trading_calendar(self, start, end):
        return pd.DataFrame([dict(date=d, trading=d.weekday() < 5)
                             for d in pd.date_range(start, end)])


class TickTest(unittest.TestCase):
    def test_all_new_rows_and_same_timestamp_ticks_survive_json(self):
        api, events = Api(), []
        api.frame.loc[1, 'datetime'] = api.frame.loc[0, 'datetime']
        collector = TickCollector(api, 10000)
        with patch('ticks.emit', lambda kind, **payload: events.extend(payload['ticks'])):
            collector.collect({'CFFEX.IM2611': META}, 100)
            self.assertEqual(api.subscriptions, [('CFFEX.IM2611', 10000)])
            self.assertEqual([r['tickId'] for r in events], ['100', '101', '102'])
            self.assertEqual(events[0]['timeNs'], events[1]['timeNs'])
            self.assertTrue(events[0]['timeNs'].endswith('123'))
            self.assertEqual(events[0]['tradingDay'], '2026-10-19')
            self.assertEqual(events[-1]['volume'], 5)
            self.assertNotIn('deltaVolume', events[-1])
            json.dumps(events, allow_nan=False)
            api.frame.loc[3] = rows((103,), (9,)).iloc[0]
            api.frame.loc[4] = rows((104,), (12,)).iloc[0]
            events.clear()
            collector.collect({'CFFEX.IM2611': META}, 101)
            self.assertEqual([r['tickId'] for r in events], ['102', '103', '104'])
            api.changed = False
            events.clear()
            collector.collect({'CFFEX.IM2611': META}, 102)
            self.assertEqual(events, [])
            api.frame.loc[5] = rows((105,), (14,)).iloc[0]
            collector.collect({'CFFEX.IM2611': META}, 103)
            self.assertEqual([r['tickId'] for r in events], ['104', '105'],
                             'tail IDs catch updates consumed by another synchronous SDK request')

    def test_window_overflow_retains_source_ids_for_gap_detection(self):
        api, events = Api(), []
        collector = TickCollector(api, 3)
        with patch('ticks.emit', lambda kind, **payload: events.extend(payload['ticks'])):
            collector.collect({'CFFEX.IM2611': META}, 100)
            collector.frames['CFFEX.IM2611'] = rows((200, 201, 202), (40, 45, 50))
            events.clear()
            collector.collect({'CFFEX.IM2611': META}, 101)
        self.assertEqual([r['tickId'] for r in events], ['200', '201', '202'])
        self.assertEqual(events[0]['volume'], 40)

    def test_restart_replays_identical_source_keys_and_bounds_batches(self):
        api = Api()
        api.frame = rows(range(100, 4601), range(4501))
        batches = []
        with patch('ticks.emit', lambda kind, **payload: batches.append(payload['ticks'])):
            TickCollector(api, 10000).collect({'CFFEX.IM2611': META}, 100)
            first = batches.copy()
            batches.clear()
            TickCollector(api, 10000).collect({'CFFEX.IM2611': META}, 200)
        self.assertEqual([len(b) for b in first], [2000, 2000, 501])
        key = lambda t: (t['symbol'], t['tradingDay'], t['timeNs'], t['tickId'])
        self.assertEqual([key(t) for b in first for t in b], [key(t) for b in batches for t in b])

    def test_calendar_night_weekend_holiday_and_reset_are_not_calendar_midnight(self):
        calendar = TickCalendar(Api())
        calendar.days = [date(2026, 9, 30), date(2026, 10, 8), date(2026, 10, 16), date(2026, 10, 19)]
        for text, expected in [
            ('2026-10-16T14:00:00', '2026-10-16'),
            ('2026-10-16T21:00:00', '2026-10-19'),
            ('2026-10-17T01:30:00', '2026-10-19'),
            ('2026-10-19T10:00:00', '2026-10-19'),
            ('2026-09-30T21:00:00', '2026-10-08'),
        ]:
            self.assertEqual(calendar.trading_day(datetime.fromisoformat(text).replace(tzinfo=TZ)), expected)
        with self.assertRaises(ValueError):
            calendar.trading_day(datetime(2026, 10, 17, 10, tzinfo=TZ))

    def test_invalid_numeric_fields_are_preserved_as_null_or_negative_for_validation(self):
        calendar = TickCalendar(Api())
        calendar.ensure(date(2026, 10, 19), date(2026, 10, 19))
        row = rows().to_dict('records')[0]
        row.update(last_price=float('nan'), volume=-1, amount=float('inf'))
        tick = normalize_tick('CFFEX.IM2611', row, META, calendar, 100)
        self.assertIsNone(tick['last'])
        self.assertIsNone(tick['amount'])
        self.assertEqual(tick['volume'], -1)
        json.dumps(tick, allow_nan=False)

    def test_continuous_maps_actual_contract_once_and_indices_are_excluded(self):
        main = Row(**{**META, 'ins_class': 'CONT', 'underlying_symbol': 'CFFEX.IM2611'})
        index = Row(ins_class='INDEX')
        symbols = ['KQ.m@CFFEX.IM', 'CFFEX.IM2611', 'SSE.000852']
        self.assertEqual(set(tick_targets(symbols, [main, META, index])), {'CFFEX.IM2611'})
        main['underlying_symbol'] = 'CFFEX.IM2612'
        self.assertEqual(set(tick_targets(symbols, [main, META, index])), {'CFFEX.IM2611', 'CFFEX.IM2612'})

    def test_provider_collects_recent_window_and_late_ticks_outside_session(self):
        class ProviderApi(Api):
            count = 0
            closed = False
            def get_quote_list(self, symbols):
                return [Row(**{**META, 'trading_time': SimpleNamespace(day=[], night=[])})]
            def get_kline_serial(self, *args, **kwargs):
                return pd.DataFrame([])
            def wait_update(self, **kwargs):
                self.count += 1
                if self.count > 2:
                    raise StopIteration()
                if self.count == 2:
                    self.frame.loc[3] = rows((103,), (9,)).iloc[0]
            def is_changing(self, value):
                return isinstance(value, pd.DataFrame)
            def close(self):
                self.closed = True
        for readonly in (False, True):
            api, events = ProviderApi(), []
            with patch.dict(sys.modules, {'tqsdk': SimpleNamespace(TqApi=lambda **kw: api, TqAuth=lambda *args: None)}), \
                 patch.object(tq_provider, 'load_catalog'), patch.object(tq_provider, 'DURATIONS', ()), \
                 patch.object(tq_provider, 'in_session', return_value=False), \
                 patch('ticks.emit', lambda kind, **payload: events.extend(payload['ticks'])), \
                 patch.object(tq_provider, 'emit'):
                with self.assertRaises(StopIteration):
                    tq_provider.run(dict(tqUser='fixture', tqPassword='fixture', symbols=['CFFEX.IM2611'],
                                         historyBars=100, historyTicks=10000, clickhouseReadOnly=readonly,
                                         beforeOpenMinutes=5, afterCloseMinutes=10))
            self.assertEqual([r['tickId'] for r in events], [] if readonly else ['100', '101', '102', '102', '103'])
            self.assertEqual(len(api.subscriptions), 0 if readonly else 1)
            self.assertTrue(api.closed)


if __name__ == '__main__':
    unittest.main()
