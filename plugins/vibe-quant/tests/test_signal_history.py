import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk'))
sys.path.insert(0, str(ROOT / 'worker'))
from quant_sdk import Bar, DataError, Event, Fees, HubClient, Instrument, LiveRunner, RunConfig, Strategy, TradingCalendar
from quant_sdk.metrics import summarize
from quant_sdk.point_metrics import summarize_points
from quant_sdk.runtime import Runner
from signal_history import MonitorHistory, history_events
from strategy_monitor import BridgeClient, SignalOutput


class Cycle(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe('CFFEX.IM2611', 60)

    def on_bar(self, ctx, bar):
        n = ctx.state.get('n', 0)
        ctx.state['n'] = n + 1
        if n % 4 == 0:
            ctx.orders.target_position(bar.symbol, 1)
        elif n % 4 == 2:
            ctx.orders.target_position(bar.symbol, 0)


class Sink:
    def __init__(self):
        self.records = {}
        self.summaries = []

    def call(self, kind, **value):
        if kind == 'history':
            batch = copy.deepcopy(value['batch'])
            for row in batch['records']:
                self.records[(row['kind'], row['id'])] = row['payload']
            if 'summary' in batch:
                self.summaries.append(batch['summary'])
        return True


class ProtectedCycle(Cycle):
    def on_bar(self, ctx, bar):
        n = ctx.state.get('n', 0)
        ctx.state['n'] = n + 1
        if n == 0:
            ctx.state['entry'] = ctx.orders.target_position(bar.symbol, 1)
            ctx.set_risk_levels(bar.symbol, entry_id=ctx.state['entry'], stop_loss=90, take_profit=120)
        elif n in (2, 3):
            ctx.set_risk_levels(bar.symbol, entry_id=ctx.state['entry'], stop_loss=95, take_profit=120)
        elif n == 4:
            ctx.orders.target_position(bar.symbol, 0)


class ClosedEntryLevels(Cycle):
    def on_bar(self, ctx, bar):
        n = ctx.state.get('n', 0)
        ctx.state['n'] = n + 1
        if n == 0:
            ctx.state['entry'] = ctx.orders.target_position(bar.symbol, 1)
            ctx.set_risk_levels(bar.symbol, entry_id=ctx.state['entry'], take_profit=105)
        elif n == 2:
            # Strategy callbacks can still refer to an entry after its protective
            # exit. A compact monitor must resolve the same ID as a full run.
            ctx.set_risk_levels(bar.symbol, entry_id=ctx.state['entry'], stop_loss=95)


class OrderAliasLifetime(Cycle):
    def on_bar(self, ctx, bar):
        n = ctx.state.get('n', 0)
        ctx.state['n'] = n + 1
        if n == 0:
            ctx.state['entry'] = ctx.orders.target_position(bar.symbol, 1)
        elif n == 1 and ctx.params['close']:
            ctx.orders.target_position(bar.symbol, 0)
        else:
            ctx.emit('sample', symbol=bar.symbol, sequence=n)
        if n == 220 and not ctx.params['close']:
            ctx.set_risk_levels(bar.symbol, entry_id=ctx.state['entry'], stop_loss=90)


class MonitorHistoryTests(unittest.TestCase):
    def test_order_alias_retention_is_bounded_and_preserves_active_entries(self):
        for close in (False, True):
            with self.subTest(close=close), tempfile.TemporaryDirectory() as directory:
                item = Instrument('CFFEX.IM2611', 'future', price_tick=1, multiplier=10, margin_rate=.1)
                config = RunConfig(initial_cash=10000, start=1792373400)
                runner = Runner(OrderAliasLifetime(), [item], config=config,
                                params={'close': close}, output_dir=directory)
                history = MonitorHistory(Sink(), runner, config.start)
                try:
                    for n in range(225):
                        t = config.start + n * 60
                        runner.process(Event(str(n), t + 60, Bar(item.symbol, t, t + 60, '2026-10-19',
                                       60, 100, 101, 99, 100, 1000)))
                        history.flush(force=True)
                        if n == 2:
                            self.assertIn(runner.context.state['entry'], [o.id for o in runner.broker.orders])
                    self.assertEqual(len(runner.broker.orders), 0 if close else 1)
                    self.assertEqual(len(runner.signals), 200 if close else 201)
                    if not close:
                        self.assertEqual(runner.broker.orders[0].id, runner.context.state['entry'])
                finally:
                    runner.journal.close()

    def test_closed_entry_order_id_survives_compaction_and_checkpoint_restore(self):
        for points in (False, True):
            with self.subTest(points=points), tempfile.TemporaryDirectory() as directory:
                item = Instrument('CFFEX.IM2611', 'future', price_tick=1, multiplier=10, margin_rate=.1)
                config = RunConfig(initial_cash=10000, start=1792373400,
                                   pnl_mode='points' if points else 'currency')
                baseline = Runner(ClosedEntryLevels(), [item], config=config, output_dir=directory)
                runner = Runner(ClosedEntryLevels(), [item], config=config, output_dir=directory)
                sink = Sink()
                history = MonitorHistory(sink, runner, config.start)
                try:
                    for n in range(3):
                        t = config.start + n * 60
                        event = Event(str(n), t + 60, Bar(item.symbol, t, t + 60, '2026-10-19', 60,
                                      100, 106 if n == 1 else 101, 99, 100, 1000))
                        baseline.process(event)
                        runner.process(event)
                        history.flush(force=True)
                        if n == 1:
                            self.assertEqual(runner.broker.position(item.symbol), 0)
                            checkpoint = runner.checkpoint()
                            state = copy.deepcopy(history.state)
                            runner.journal.close()
                            runner = Runner.restore(ClosedEntryLevels(), checkpoint, output_dir=directory)
                            history = MonitorHistory(sink, runner, config.start, state)
                    self.assertEqual(runner.signals, baseline.signals)
                    self.assertEqual(history.summary()['metrics']['trade_count'], 1)
                    self.assertEqual(history.summary()['open_trades'], [])
                    self.assertEqual([r for (kind, _), r in sink.records.items() if kind == 'trade'][0]['net_pnl'],
                                     baseline.broker.trades[0]['net_pnl'])
                finally:
                    baseline.journal.close()
                    runner.journal.close()

    def test_index_rule_adaptation_is_scoped_to_point_monitor_symbol(self):
        class Client(BridgeClient):
            def request(self, *args, **kwargs):
                return {'kind': 'stock', 'priceTick': .01}
        def rules(symbol, metadata):
            return Instrument(symbol, metadata['kind'], price_tick=.01, multiplier=1, margin_rate=1)
        points = Client('SSE.000852', 'points')
        self.assertEqual(points.rules('SSE.000852', rules).kind, 'future')
        with self.assertRaisesRegex(DataError, 'cannot be traded'):
            points.rules('SZSE.399006', rules)
        with self.assertRaisesRegex(DataError, 'cannot be traded'):
            Client().rules('SSE.000852', rules)

    def test_point_metrics_match_full_run_through_compaction_and_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            item = Instrument('CFFEX.IM2611', 'future', price_tick=1, multiplier=200, margin_rate=.12)
            config = RunConfig(pnl_mode='points', initial_cash=1, point_cost=.5, start=1792373400)
            baseline = Runner(Cycle(), [item], config=config, output_dir=directory, params={'execution_model': 'points'})
            sink = Sink()
            runner = Runner(Cycle(), [item], config=config, output_dir=directory, params={'execution_model': 'points'})
            history = MonitorHistory(sink, runner, config.start)
            self.assertEqual(history.summary()['metrics']['total_points'], 0)
            for n in range(96):
                t = config.start + n * 60
                price = 100 + n % 9
                event = Event(str(n), t + 60, Bar(item.symbol, t, t + 60, '2026-10-19', 60,
                              price, price + 1, price - 1, price, 0))
                baseline.process(event)
                runner.process(event)
                history.flush(force=True)
                if n == 49:
                    checkpoint = runner.checkpoint()
                    state = copy.deepcopy(history.state)
                    runner.journal.close()
                    runner = Runner.restore(Cycle(), checkpoint, output_dir=directory)
                    history = MonitorHistory(sink, runner, config.start, state)
                    self.assertEqual(len(history.summary()['open_trades']), 1)
            expected = summarize_points(baseline.curve, baseline.broker.trades)
            actual = history.summary()
            self.assertEqual(actual['pnl_unit'], 'points')
            self.assertEqual(actual['execution_model'], 'points')
            self.assertEqual(actual['metrics'], expected['metrics'])
            self.assertEqual(actual['monthly_returns'], expected['monthly_returns'])
            self.assertEqual(actual['yearly_returns'], expected['yearly_returns'])
            self.assertGreater(actual['metrics']['max_drawdown_points'], 0)
            self.assertIsNone(actual['metrics']['max_drawdown'])
            self.assertEqual([value for (kind, _), value in sink.records.items() if kind == 'trade'], baseline.broker.trades)
            runner.journal.close()
            baseline.journal.close()

    def test_protection_path_survives_checkpoint_and_position_close(self):
        with tempfile.TemporaryDirectory() as directory:
            item = Instrument('CFFEX.IM2611', 'future', price_tick=1, multiplier=10, margin_rate=.1)
            config = RunConfig(initial_cash=10000, start=1792373400)
            sink = Sink()
            runner = LiveRunner(ProtectedCycle(), [item], mode='paper', config=config, output_dir=directory)
            history = MonitorHistory(sink, runner, config.start)
            for n in range(6):
                t = config.start + n * 60
                runner.process(Event(str(n), t+60, Bar(item.symbol,t,t+60,'2026-10-19',60,100,101,99,100,1000)))
                history.flush(force=True)
                if n == 2:
                    checkpoint = runner.checkpoint()
                    state = copy.deepcopy(history.state)
                    runner.journal.close()
                    runner = LiveRunner.restore(ProtectedCycle(), checkpoint, output_dir=directory)
                    history = MonitorHistory(sink, runner, config.start, state)
                    self.assertEqual([r['stop_loss'] for r in history.summary()['open_trades'][0]['risk_levels']], [90,95])
            trades = [value for (kind, _), value in sink.records.items() if kind == 'trade']
            self.assertEqual(len(trades), 1)
            levels = trades[0]['risk_levels']
            self.assertEqual([r['stop_loss'] for r in levels], [90,95,95])
            self.assertTrue(all(r['entry_signal_id'] == trades[0]['entry_signal_id'] for r in levels))
            self.assertEqual(history.state['risk_levels'], {})
            self.assertEqual(runner.risk_levels, [])
            runner.journal.close()

    def test_incremental_metrics_and_trade_ids_survive_compaction_and_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            item = Instrument('CFFEX.IM2611', 'future', price_tick=1, multiplier=10,
                              margin_rate=.1, fees=Fees(per_unit=1))
            config = RunConfig(initial_cash=10000, start=1792373400)
            baseline = LiveRunner(Cycle(), [item], mode='paper', config=config, output_dir=directory)
            sink = Sink()
            output = SignalOutput(sink, 99999999999)
            runner = LiveRunner(Cycle(), [item], mode='paper', config=config, output_dir=directory, on_event=output)
            history = MonitorHistory(sink, runner, config.start)
            output.runner, output.history = runner, history
            for n in range(96):
                t = config.start + n * 60
                price = 100 + n % 9
                event = Event(str(n), t + 60, Bar(item.symbol, t, t + 60, '2026-10-19', 60,
                              price, price + 1, price - 1, price, 1000))
                baseline.process(event)
                output.event = event
                runner.process(event)
                history.flush(force=True)
                if n == 49:
                    checkpoint = runner.checkpoint()
                    old_state = copy.deepcopy(history.state)
                    runner.journal.close()
                    runner = LiveRunner.restore(Cycle(), checkpoint, output_dir=directory, on_event=output)
                    history = MonitorHistory(sink, runner, config.start, old_state)
                    output.runner, output.history = runner, history
                    self.assertEqual(len(history.summary()['open_trades']), 1)
            expected = summarize(baseline.curve, baseline.broker.trades, config)
            actual = history.summary()
            for key, value in expected['metrics'].items():
                self.assertEqual(actual['metrics'][key], value, key)
            self.assertEqual(actual['monthly_returns'], expected['monthly_returns'])
            self.assertEqual(actual['yearly_returns'], expected['yearly_returns'])
            trades = [value for (kind, _), value in sink.records.items() if kind == 'trade']
            self.assertEqual(trades, baseline.broker.trades)
            self.assertEqual(runner.broker.fill_sequence, baseline.broker.fill_sequence)
            self.assertEqual(runner.broker.trade_sequence, baseline.broker.trade_sequence)
            self.assertEqual(runner.broker.trades, [])
            self.assertEqual(runner.broker.fills, [])
            self.assertEqual(len([key for key in sink.records if key[0] == 'signal']), 48)
            runner.journal.close()
            baseline.journal.close()

    def test_missing_execution_history_does_not_silently_report_zero_trades(self):
        from quant_sdk.hub import DataError
        item = Instrument('CFFEX.IM2611', 'future', price_tick=1, multiplier=10, margin_rate=.1)
        class EmptyClient:
            def rules(self, *_): return item
            def history(self, *_): return iter(())
        with tempfile.TemporaryDirectory() as directory:
            runner = LiveRunner(Cycle(), [item], mode='paper', output_dir=directory)
            with self.assertRaisesRegex(DataError, 'Missing execution history'):
                list(history_events(EmptyClient(), runner, item.symbol, 300, 100, 1000, None, None))
            runner.journal.close()

    def test_full_replay_pages_all_available_history_and_aggregates_three_minutes(self):
        start = 1792373400
        item = Instrument('CFFEX.IM2611', 'future', price_tick=1, multiplier=10, margin_rate=.1)
        class Client(HubClient):
            def __init__(self):
                self.requests = []
            def rules(self, symbol, rules):
                return item
            def request(self, path, *, params):
                self.requests.append(params)
                rows = [dict(symbol=item.symbol, duration=60, time=start+n*60, open=100, high=101,
                             low=99, close=100, volume=1000) for n in range(1500)
                        if start+n*60 > params['after'] and start+n*60 < params['before']][:1000]
                return {'bars': rows, 'next': rows[-1]['time'] if len(rows) == 1000 else None}
        client = Client()
        calendar = TradingCalendar({'2026-10-19': True, '2026-10-20': True, '2026-10-21': True})
        with tempfile.TemporaryDirectory() as directory:
            runner = LiveRunner(Cycle(), [item], mode='paper', output_dir=directory)
            events = list(history_events(client, runner, item.symbol, 180, start, start+1500*60, calendar, None))
            self.assertEqual(len([e for e in events if e.payload.duration == 60]), 1500)
            self.assertEqual(len([e for e in events if e.payload.duration == 180]), 500)
            self.assertTrue(any(p['after'] == start-1 for p in client.requests))
            self.assertTrue(any(p['after'] == start+999*60 for p in client.requests))
            self.assertEqual([e.available_at for e in events], sorted(e.available_at for e in events))
            runner.journal.close()


if __name__ == '__main__':
    unittest.main()
