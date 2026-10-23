import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
import tq_provider


class Row(dict):
    __getattr__ = dict.__getitem__


class QuotesTest(unittest.TestCase):
    def collect_tq_quotes(self, snapshots):
        item = Row(datetime='2026-10-23 09:30:00', underlying_symbol='', ins_class='FUTURE',
                   trading_time=SimpleNamespace(day=[], night=[]), last_price=8000,
                   pre_close=7950, open=7960, volume=12345, open_interest=54321,
                   bid_price1=7999.8, ask_price1=8000.2)
        updates = iter(snapshots)
        events = []

        def advance(**kwargs):
            snapshot = next(updates)
            item.pop('highest', None)
            item.pop('lowest', None)
            item.update(snapshot)

        def emit(kind, **payload):
            if kind == 'data':
                events.extend(json.loads(json.dumps(payload['quotes'], allow_nan=False)))

        api = SimpleNamespace(
            get_quote_list=lambda symbols: [item],
            get_kline_serial=lambda *args, **kwargs: object(),
            is_serial_ready=lambda frame: False,
            get_trading_calendar=lambda *args: SimpleNamespace(to_dict=lambda mode: []),
            wait_update=advance,
            is_changing=lambda value: True,
            close=Mock(),
        )
        with patch.dict(sys.modules, {'tqsdk': SimpleNamespace(TqApi=lambda **kw: api, TqAuth=lambda *args: None)}), \
             patch.object(tq_provider, 'load_catalog'), patch.object(tq_provider, 'DURATIONS', ()), \
             patch.object(tq_provider, 'in_session', return_value=True), \
             patch.object(tq_provider, 'emit', emit):
            with self.assertRaises(StopIteration):
                tq_provider.run(dict(tqUser='fixture', tqPassword='fixture', symbols=['CFFEX.IM2611'],
                                     historyBars=100, beforeOpenMinutes=5, afterCloseMinutes=10,
                                     clickhouseReadOnly=True))
        api.close.assert_called_once_with()
        self.assertEqual(len(events), len(snapshots))
        return events

    def test_tq_emits_daily_high_and_low_on_initial_quote_and_updates(self):
        quotes = self.collect_tq_quotes([
            {'highest': 8050, 'lowest': 7920},
            {'highest': 8060, 'lowest': 7910},
        ])
        self.assertEqual([(quote['high'], quote['low']) for quote in quotes],
                         [(8050, 7920), (8060, 7910)])
        expected = dict(last=8000, preClose=7950, open=7960, volume=12345,
                        openInterest=54321, bid=7999.8, ask=8000.2)
        self.assertEqual({key: quotes[0][key] for key in expected}, expected)

    def test_tq_missing_or_nonfinite_extrema_remain_null(self):
        quotes = self.collect_tq_quotes([
            {'highest': 8050, 'lowest': 7920},
            {'highest': float('nan'), 'lowest': 7920},
            {'highest': 8050, 'lowest': float('inf')},
            {},
        ])
        self.assertEqual([(quote['high'], quote['low']) for quote in quotes],
                         [(8050, 7920), (None, 7920), (8050, None), (None, None)])


if __name__ == '__main__':
    unittest.main()
