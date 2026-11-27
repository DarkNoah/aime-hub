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
from monitor_options import LiveOptionEvents, MarketOptionCoverage
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
    def simulate(self, *, live=False, dry=False, omit=None, targets=None, mappings=None, observations=None):
        raw, ticker = fixture('IF', main=not live, right='P')
        config = raw['config']
        source = config['symbol']
        if omit:
            raw['bars'] = [r for r in raw['bars'] if not omit(r)]
        if mappings is not None:
            raw['mappings'][source] = mappings
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
                            params={'symbol':source, 'targets':targets or {'0':-2}, 'option_take_profit_pct':10}, output_dir=directory, on_event=output)
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
                coverage = MarketOptionCoverage(runner)
                for raw_event in events:
                    for event in coverage.accept(raw_event):
                        output.event = event
                        runner.process(event)
                        history.flush()
                if observations is not None:
                    observations.extend(b.time for b in runner.data.history(source, 60))
                    if not observations:
                        self.assertEqual(history.summary()['equity_curve'], [])
                        self.assertFalse(runner.broker.orders)
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

    def test_all_or_partial_missing_option_minutes_do_not_run_the_strategy(self):
        for live in [False, True]:
            for missing in ['CFFEX.IO', 'SSE.000300']:
                observed = []
                _, signals = self.simulate(live=live, omit=lambda r: r['symbol'].startswith(missing),
                                           observations=observed)
                self.assertEqual((signals, observed), ([], []))
                ticker, signals = self.simulate(live=live,
                    omit=lambda r: r['symbol'].startswith(missing) and r['time'] == START,
                    targets={'0':-1, '1':-1}, observations=observed)
                self.assertNotIn(START, observed)
                self.assertEqual(signals[0]['symbol'], ticker)
                self.assertGreaterEqual(signals[0]['time'], START + 120)

    def test_partial_mapping_and_actual_contract_gaps_resume_at_next_valid_minute(self):
        observed = []
        contract = 'CFFEX.IF2611'
        mappings = [dict(time=START+60, underlying=contract), dict(time=START+120, underlying=''),
                    dict(time=START+240.5, underlying=contract)]
        _, signals = self.simulate(mappings=mappings, observations=observed,
            omit=lambda r: r['symbol']==contract and r['time']==START+60)
        self.assertEqual(observed, [START+240])
        self.assertEqual(signals, [])
        observed.clear()
        self.simulate(mappings=[], observations=observed)
        self.assertEqual(observed, [])

    def test_no_option_volume_no_market_entry_marker(self):
        self.assertEqual(self.simulate(live=True, dry=True)[1], [])
