from pathlib import Path
from datetime import datetime
from threading import Event
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'sdk'), str(ROOT / 'worker')]
from quant_sdk import Fees, Instrument, RunConfig, TradingCalendar
from quant_sdk.hub import HubClient, convert_bar, event_for, option_bars
from quant_sdk.runtime import Runner
from monitor_options import LiveOptionEvents
from signal_history import history_events, MonitorHistory
from strategy_monitor import SignalOutput
from test_option_execution import fixture, Targets, START
from test_signal_history import Sink


class Market(HubClient):
    def __init__(self, raw):
        self.raw = raw

    def option_chain(self, source, start, end):
        return [item for item in self.raw['instruments'].values() if item['kind'] == 'option']

    def request(self, path, *, params):
        if path == '/option-volume-prefix':
            names = params['symbols'].split(',')
            return [dict(symbol=r['symbol'], stamp=r['time'], lots=r['volume']) for r in self.raw['bars']
                    if r['symbol'] in names and r['time'] < params['start']]
        assert path == '/option-minutes'
        symbols = params['symbols'].split(',')
        rows = sorted((r for r in self.raw['bars'] if r['symbol'] in symbols
                       and params['start'] <= r['time'] < params['end']), key=lambda r: (r['time'], r['symbol']))
        return {'bars': rows, 'next': None}

    def rules(self, symbol, resolver):
        return resolver(symbol, self.raw['instruments'][symbol])

    def history(self, symbol, duration, start, end):
        return [r for r in self.raw['bars'] if r['symbol'] == symbol and r['duration'] == duration
                and start <= r['time'] < end]

    def contracts(self, symbol, start, end):
        return self.raw['mappings'][symbol]


class MarketOptionExecutionTest(unittest.TestCase):
    def simulate(self, *, live=False, dry=False):
        raw, ticker = fixture('IF', main=not live, right='P')
        config = raw['config']
        source = config['symbol']
        if dry:
            for row in raw['bars']:
                if row['symbol'] != source:
                    row['volume'] = 0
        market, sink = Market(raw), Sink()
        calendar = TradingCalendar(config['calendar'])
        fees = Fees(per_unit=2)
        def rules(symbol, meta):
            return Instrument(symbol, meta['kind'], price_tick=.2, multiplier=200, margin_rate=.1, fees=fees)
        item = market.rules(source, rules)
        with tempfile.TemporaryDirectory() as directory:
            output = SignalOutput(sink, START)
            runner = Runner(Targets(), [item], config=RunConfig(initial_cash=25000, participation_rate=.1,
                            option_execution={'mode': 'time_value_third'}), mode='paper',
                            params={'symbol':source, 'targets':{'0':-2}, 'option_take_profit_pct':10}, output_dir=directory, on_event=output)
            history = MonitorHistory(sink, runner, START)
            output.runner, output.history = runner, history
            runner._maybe_checkpoint = lambda: None
            if live:
                class Stream:
                    stop_event = Event()
                    def __iter__(self):
                        for row in market.history(source, 60, START, START + 300):
                            yield event_for(convert_bar(row, item, calendar), row['time'] + 60.25)
                events = LiveOptionEvents(Stream(), market, source, fees, calendar)
            else:
                events = history_events(market, runner, source, 60, START, START + 300, calendar, rules)
            try:
                for event in events:
                    output.event = event
                    runner.process(event)
                    history.flush()
                history.flush(force=True)
            finally:
                runner.journal.close()
        return ticker, [v for (kind, _), v in sink.records.items() if kind == 'signal']

    def test_history_emits_filled_put_and_realized_premium_profit(self):
        ticker, signals = self.simulate()
        self.assertEqual([(s['type'], s['side'], s['symbol']) for s in signals],
                         [('entry', 'short', ticker), ('exit', 'short', ticker)])
        self.assertEqual(signals[1]['pnl'], {'value':1196, 'unit':'currency', 'basis':'realized'})

    def test_live_receipt_cannot_fill_at_an_open_before_the_decision(self):
        ticker, signals = self.simulate(live=True)
        self.assertEqual(signals[0]['symbol'], ticker)
        self.assertEqual(signals[0]['time'], START + 120)
        self.assertEqual(signals[0]['price'], 112)

    def test_live_and_history_resolve_the_same_put(self):
        for live in [False, True]:
            ticker, signals = self.simulate(live=live)
            self.assertEqual((signals[0]['side'], signals[0]['symbol']), ('short', ticker))

    def test_overnight_prefix_and_trading_day_reset(self):
        symbol = 'DCE.m2701-C-3000'
        calendar = TradingCalendar({'2026-11-27':True, '2026-11-28':False, '2026-11-29':False,
                                    '2026-11-30':True, '2026-12-01':True})
        def at(stamp):
            return int(datetime.fromisoformat(stamp + '+08:00').timestamp())
        def row(stamp, volume):
            return dict(symbol=symbol, duration=60, time=at(stamp), open=100, high=100, low=100, close=100, volume=volume)
        market = Market({'bars': [row('2026-11-27T14:59', 3000), row('2026-11-27T21:00', 970),
                                  row('2026-11-30T09:00', 15), row('2026-11-30T09:01', 10),
                                  row('2026-12-01T09:00', 20)]})
        item = Instrument(symbol, 'option', .5, multiplier=10, option_underlying='DCE.m2701', option_right='C', strike=3000)
        bars = list(option_bars(market, {symbol:item}, at('2026-11-30T09:01'), at('2026-12-01T09:01'), calendar))
        self.assertEqual([(b.trading_day, b.day_volume) for b in bars], [('2026-11-30', 995), ('2026-12-01', 20)])

    def test_no_option_volume_no_market_entry_marker(self):
        self.assertEqual(self.simulate(live=True, dry=True)[1], [])
