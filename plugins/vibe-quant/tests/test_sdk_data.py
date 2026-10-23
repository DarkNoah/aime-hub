import json
from dataclasses import replace
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
from threading import Thread
import unittest
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import (DataError, Dataset, Event, HubClient, Instrument, InstrumentUpdate,
                       LiveRunner, RunConfig, Strategy, TradingCalendar, backtest)
from quant_sdk.models import Bar, Roll
from quant_sdk.data import DataView
from test_strategy_sdk import Trend

TZ = ZoneInfo('Asia/Shanghai')


def epoch(value):
    return datetime.fromisoformat(value).replace(tzinfo=TZ).timestamp()


START = epoch('2026-10-19T09:30:00')
MAIN = 'KQ.m@CFFEX.IM'
ACTUAL = 'CFFEX.IM2611'
CALENDAR = TradingCalendar({'2026-10-16': True, '2026-10-17': False, '2026-10-18': False,
                            '2026-10-19': True, '2026-10-20': True})


def rules(symbol, metadata):
    return Instrument(symbol, metadata['kind'], .2, multiplier=200, margin_rate=.12)


def row(symbol, n, price=8000):
    return {'symbol': symbol, 'time': START + n * 60, 'duration': 60, 'open': price,
            'high': price + 1, 'low': price - 1, 'close': price, 'volume': 1000}


class FixtureClient(HubClient):
    def __init__(self):
        self.calls, self.polls, self.closed = [], [], False
        self.mapping = [{'time': START - 1, 'underlying': ACTUAL}]

    def request(self, path, *, method='GET', params=None, body=None):
        self.calls.append((path, method, params, body))
        if path.startswith('/instruments/'):
            return {'kind': 'continuous' if 'KQ.' in path else 'future'}
        if path == '/contracts':
            return {'mappings': self.mapping, 'next': None}
        if path == '/history':
            # Small pages exercise the SDK cursor, including a short final page.
            rows = [row(params['symbol'], n, 8000 + n) for n in range(6)]
            rows = [r for r in rows if params['after'] < r['time'] < params['before']][:2]
            return {'bars': rows, 'next': rows[-1]['time'] if len(rows) == 2 else None}
        if path == '/sessions':
            return {'id': 'fixture', 'cursor': 'epoch:0', 'serverTime': START, 'initialQuotes': []}
        if method == 'DELETE':
            self.closed = True
            return {'closed': True}
        if '/events' in path:
            return self.polls.pop(0)
        raise AssertionError(path)


class SDKDataTest(unittest.TestCase):
    def test_calendar_uses_exchange_dates_and_night_session(self):
        for stamp in ('2026-10-16T21:00:00', '2026-10-17T01:00:00'):
            self.assertEqual(CALENDAR.trading_day(epoch(stamp), futures=True), '2026-10-19')
        end, day = CALENDAR.bar_end(epoch('2026-10-16T21:00:00'), 86400, futures=True)
        self.assertEqual(end, epoch('2026-10-19T15:00:00'))
        self.assertEqual(day, '2026-10-19')
        with self.assertRaisesRegex(ValueError, 'calendar'):
            CALENDAR.trading_day(epoch('2026-10-21T09:30:00'))

    def test_snapshot_pages_and_pins_actual_contract_data(self):
        client = FixtureClient()
        dataset = client.snapshot([MAIN], start=START, end=START + 360, calendar=CALENDAR, rules=rules)
        self.assertEqual({i.symbol for i in dataset.instruments}, {MAIN, ACTUAL})
        self.assertIsInstance(dataset.events[0].payload, Roll)
        bars = [e.payload for e in dataset.events if isinstance(e.payload, Bar)]
        self.assertEqual(len(bars), 12)
        self.assertEqual(dataset.events[1].payload.symbol, ACTUAL)
        self.assertEqual(len([c for c in client.calls if c[0] == '/history']), 8)
        changed = Dataset(dataset.instruments, dataset.events, metadata={'changed': True})
        self.assertNotEqual(dataset.fingerprint, changed.fingerprint)
        client.mapping = []
        with self.assertRaisesRegex(DataError, 'No observed contract mapping'):
            client.snapshot([MAIN], start=START, end=START + 360, calendar=CALENDAR, rules=rules)

    def test_three_minute_snapshot_requires_complete_minutes(self):
        client = FixtureClient()
        dataset = client.snapshot([MAIN], start=START, end=START + 360, calendar=CALENDAR, rules=rules, duration=180)
        bars = [e.payload for e in dataset.events if isinstance(e.payload, Bar) and e.payload.symbol == MAIN]
        self.assertEqual([b.volume for b in bars], [3000, 3000])
        self.assertEqual([b.close for b in bars], [8002, 8005])
        partial = client.snapshot([MAIN], start=START + 60, end=START + 360, calendar=CALENDAR, rules=rules, duration=180)
        self.assertEqual(len([e for e in partial.events if isinstance(e.payload, Bar) and e.payload.symbol == MAIN]), 1)

    def test_missing_execution_minute_rejects_snapshot(self):
        client = FixtureClient()
        original = client.history
        client.history = lambda symbol, *args: (r for r in original(symbol, *args)
                                                if not (symbol == ACTUAL and r['time'] == START + 120))
        with self.assertRaisesRegex(DataError, 'Missing actual-contract execution bar'):
            client.snapshot([MAIN], start=START, end=START + 360, calendar=CALENDAR, rules=rules)

    def test_live_adapter_registers_contract_and_replays_identically(self):
        client = FixtureClient()
        for n, price in enumerate([8000, 8001, 8002, 8000, 7999]):
            client.polls.append({'cursor': f'epoch:{n + 1}', 'status': {'state': 'syncing'}, 'batches': [{
                'receivedAt': START + (n + 1) * 60,
                'quotes': [{'symbol': MAIN, 'time': START + n * 60, 'underlying': ACTUAL, 'last': price}],
                'bars': [row(ACTUAL, n, price), row(MAIN, n, price)],
            }]})
        with tempfile.TemporaryDirectory() as directory:
            with client.stream([MAIN], calendar=CALENDAR, rules=rules) as stream:
                runner = LiveRunner(Trend(), stream.instruments, params={'symbol': MAIN},
                                    config=RunConfig(initial_cash=1_000_000), mode='paper', output_dir=directory)
                events = []
                for _ in range(5):
                    for event in stream.poll():
                        events.append(event)
                        runner.process(event)
                live = runner.finish()
                replay = backtest.run(Trend(), Dataset(stream.instruments, events), params={'symbol': MAIN},
                                      config=RunConfig(initial_cash=1_000_000), output_dir=directory)
                self.assertEqual(live['status'], 'succeeded', live['message'])
                self.assertEqual(replay['status'], 'succeeded', replay['message'])
                self.assertEqual(live['signals'], replay['signals'])
                self.assertEqual(live['fills'], replay['fills'])
                self.assertEqual(live['metrics'], replay['metrics'])
                self.assertTrue(live['trades'])
            self.assertTrue(client.closed)

    def test_live_three_minute_dedup_and_unclosed_bars(self):
        client = FixtureClient()
        def page(rows, at=START + 180):
            return {'cursor': 'epoch:1', 'status': {'state': 'syncing'}, 'batches': [{
                'receivedAt': at, 'quotes': [], 'bars': rows}]}
        # Direct actual-contract strategy receives minute execution bars plus 3m signals.
        client.polls = [page([row(ACTUAL, n) for n in range(4)]), page([row(ACTUAL, n) for n in range(4)])]
        with client.stream([ACTUAL], calendar=CALENDAR, rules=rules, duration=180) as stream:
            events = stream.poll()
            self.assertEqual([e.payload.duration for e in events], [60, 60, 60, 180])
            self.assertEqual(stream.poll(), [])

    def test_older_roll_and_partial_correction_cannot_regress_data(self):
        view = DataView([rules(MAIN, {'kind': 'continuous'}), rules(ACTUAL, {'kind': 'future'}),
                         rules('CFFEX.IM2612', {'kind': 'future'})])
        view._apply(Event('a', START, Roll(MAIN, ACTUAL, START, '2026-10-19')))
        view._apply(Event('b', START + 2, Roll(MAIN, 'CFFEX.IM2612', START + 2, '2026-10-19')))
        view._apply(Event('c', START + 3, Roll(MAIN, ACTUAL, START + 1, '2026-10-19')))
        self.assertEqual(view.resolve_contract(MAIN), 'CFFEX.IM2612')
        bar = Bar(ACTUAL, START, START + 60, '2026-10-19', 60, 1, 2, 1, 2, 100)
        view._apply(Event('bar', START + 60, bar))
        view._apply(Event('partial', START + 61, replace(bar, is_final=False)))
        self.assertEqual(len(view.history(ACTUAL, 60)), 1)

    def test_checkpoint_preserves_unacknowledged_signal_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            def fail(output):
                raise RuntimeError('consumer down')
            runner = LiveRunner(Trend(), [rules(ACTUAL, {'kind': 'future'})], params={'symbol': ACTUAL},
                                output_dir=directory, on_event=fail)
            a = Bar(ACTUAL, START, START + 60, '2026-10-19', 60, 1, 2, 1, 1, 100)
            b = replace(a, time=START + 60, end_time=START + 120, close=2)
            runner.process(Event('a', a.end_time, a))
            with self.assertRaisesRegex(RuntimeError, 'consumer down'):
                runner.process(Event('b', b.end_time, b))
            delivered = []
            restored = LiveRunner.restore(Trend(), runner.directory / 'checkpoint.json', output_dir=directory, on_event=delivered.append)
            runner.finish('failed')
            restored.finish()
            self.assertEqual(delivered[0]['type'], 'signal')
            self.assertEqual(delivered[0]['payload']['id'], restored.signals[0]['id'])

    def test_http_adapter_auth_origin_and_redirect_safety(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                seen.append((self.path, self.headers.get('Cookie'), self.headers.get('Origin')))
                if 'redirect' in self.path:
                    self.send_response(302)
                    self.send_header('Location', '/leak')
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"kind":"stock"}')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = HubClient(f'http://127.0.0.1:{server.server_port}/api/plugins/vibe-quant',
                               headers={'Cookie': 'fixture-session', 'Origin': 'http://localhost:5173'})
            self.assertEqual(client.instrument('SSE.600000')['kind'], 'stock')
            self.assertEqual(seen[0][1:], ('fixture-session', 'http://localhost:5173'))
            with self.assertRaisesRegex(DataError, 'HTTP 302'):
                client.instrument('redirect')
            self.assertEqual(len(seen), 2, 'credentials must not be forwarded through redirects')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
