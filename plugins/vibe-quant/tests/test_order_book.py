import json
import sys
import time
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
from order_book import tq_book, tdx_book, tushare_book
from tdx_provider import Provider as TdxProvider
from tushare_provider import Provider as TushareProvider
import tq_provider


class OrderBookTest(unittest.TestCase):
    def test_five_levels_keep_positions_units_and_underlying(self):
        row = {'underlying_symbol': 'CFFEX.IM2610'}
        for level in range(1, 6):
            row.update({f'bid_price{level}': 8000 - level, f'ask_price{level}': 8000 + level,
                        f'bid_volume{level}': level * 7, f'ask_volume{level}': level * 9})
        book = tq_book('KQ.m@CFFEX.IM', row, 100.25, 200.5)
        self.assertEqual(book['bidPrices'], [7999, 7998, 7997, 7996, 7995])
        self.assertEqual(book['askVolumes'], [9, 18, 27, 36, 45])
        self.assertEqual(book['underlying'], 'CFFEX.IM2610')
        self.assertEqual((book['sourceTime'], book['receivedAt']), (100.25, 200.5))

    def test_invalid_and_missing_depth_does_not_move_other_levels(self):
        row = {'bid_price1': 10, 'bid_volume1': 0, 'bid_price3': 9, 'bid_volume3': 5,
               'ask_price1': float('nan'), 'ask_volume1': 100,
               'ask_price2': 0, 'ask_volume2': 99, 'ask_price3': 11, 'ask_volume3': -1,
               'ask_price4': float('inf'), 'ask_volume4': float('inf')}
        book = tq_book('SSE.600000', row, 100)
        self.assertEqual(book['bidVolumes'], [0, None, 5, None, None])
        self.assertEqual(book['askPrices'], [None, None, 11, None, None])
        self.assertEqual(book['askVolumes'], [None] * 5)
        json.dumps(book, allow_nan=False)

    def test_tdx_preserves_observations_without_fabricating_source_time(self):
        row = {'bid1': 10, 'bid_vol1': 25, 'ask5': 11, 'ask_vol5': 13}
        first = tdx_book('SSE.600000', row, 100)
        second = tdx_book('SSE.600000', {**row, 'bid_vol1': 26}, 100)
        self.assertNotEqual(first['snapshotId'], second['snapshotId'])
        self.assertIsNone(first['sourceTime'])
        self.assertEqual(first['timePrecision'], 'unknown')
        self.assertEqual(first['askVolumes'][4], 13)
        self.assertEqual(first['volumeUnit'], 'source')

    def test_one_level_source_and_empty_book_clear_previous_snapshot(self):
        first = tushare_book('SSE.600000', {'bid_price1': 10, 'bid_volume1': 1234}, 100)
        empty = tushare_book('SSE.600000', {}, 101)
        self.assertEqual(first['bidVolumes'], [1234])
        self.assertEqual(first['volumeUnit'], 'share')
        self.assertEqual(empty['bidPrices'], [None])
        self.assertEqual(empty['askPrices'], [None])

    def test_tq_emits_volume_only_changes_at_same_source_time_without_a_trade(self):
        class Row(dict):
            __getattr__ = dict.__getitem__

        item = Row(datetime='2026-10-16 09:30:00', underlying_symbol='CFFEX.IM2610', ins_class='CONT',
                   trading_time=SimpleNamespace(day=[], night=[]), bid_price1=8000, bid_volume1=5)
        class Api:
            count = 0
            closed = False
            def get_quote_list(self, symbols):
                return [item]
            def get_trading_calendar(self, *args):
                return SimpleNamespace(to_dict=lambda mode: [])
            def wait_update(self, **kwargs):
                self.count += 1
                if self.count > 2:
                    raise StopIteration()
                item['bid_volume1'] += 1
            def is_changing(self, value):
                return True
            def close(self):
                self.closed = True
        api = Api()
        events = []
        with patch.dict(sys.modules, {'tqsdk': SimpleNamespace(TqApi=lambda **kw: api, TqAuth=lambda *args: None)}), \
             patch.object(tq_provider, 'load_catalog'), patch.object(tq_provider, 'DURATIONS', ()), \
             patch.object(tq_provider, 'in_session', return_value=True), \
             patch.object(tq_provider, 'emit', lambda kind, **payload: events.append((kind, payload))):
            with self.assertRaises(StopIteration):
                tq_provider.run(dict(tqUser='fixture', tqPassword='fixture', symbols=['KQ.m@CFFEX.IM'],
                                     historyBars=100, beforeOpenMinutes=5, afterCloseMinutes=10))
        data = [payload for kind, payload in events if kind == 'data']
        self.assertEqual([event['quotes'] for event in data], [[], []])
        books = [event['orderBooks'][0] for event in data]
        self.assertEqual([book['bidVolumes'][0] for book in books], [6, 7])
        self.assertEqual(books[0]['sourceTime'], books[1]['sourceTime'])
        self.assertNotEqual(books[0]['snapshotId'], books[1]['snapshotId'])
        self.assertTrue(api.closed)

    def test_tdx_emits_depth_before_history_failure_and_skips_indices(self):
        class Connection:
            def call(self, method, *args, **kwargs):
                if method == 'get_security_quotes':
                    return [dict(market=1, code=code, bid1=10, bid_vol1=5)
                            for code in ('600000', '000852')]
                raise RuntimeError('historical data unavailable')
        provider = object.__new__(TdxProvider)
        provider.connection = Connection()
        events = []
        with patch('tdx_provider.emit', lambda kind, **payload: events.append(payload)):
            with self.assertRaises(RuntimeError):
                provider.poll(['SSE.600000', 'SSE.000852'], False)
        self.assertEqual([book['symbol'] for book in events[0]['orderBooks']], ['SSE.600000'])
        self.assertEqual(events[0]['orderBooks'][0]['bidVolumes'][0], 5)

    def test_tushare_requests_depth_only_for_stocks_and_emits_without_last_trade(self):
        provider = TushareProvider({})
        provider.indices.add('SSE.000852')
        provider.last_bars = time.monotonic()
        calls, events = [], []

        def request(api, **params):
            calls.append((api, params['fields']))
            return [dict(ts_code='000852.SH' if api == 'rt_idx_k' else '600000.SH',
                         trade_time='2026-10-16 09:25:00', bid_price1=10, bid_volume1=100)]

        provider.request = request
        with patch('tushare_provider.emit', lambda kind, **payload: events.append(payload)):
            provider.poll(['SSE.600000', 'SSE.000852'], False)
        self.assertIn('ask_volume1', calls[0][1])
        self.assertNotIn('ask_volume1', calls[1][1])
        self.assertEqual(events[0]['quotes'], [])
        self.assertEqual(events[0]['orderBooks'][0]['bidVolumes'], [100])
        self.assertEqual(events[1]['orderBooks'], [])


if __name__ == '__main__':
    unittest.main()
