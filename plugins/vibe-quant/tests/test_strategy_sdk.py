import json
from pathlib import Path
import sys
import tempfile
from threading import Event as StopEvent
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Bar, Dataset, Event, Fees, Instrument, LiveRunner, Quote, Roll, RunConfig, Strategy, backtest
from quant_sdk.data import DataView
from quant_sdk.execution import PaperBroker


def candle(symbol, minute, close, *, day='2026-10-19', volume=1000, open_price=None, offset=0):
    start = 1792373400 + offset + minute * 60
    opening = close if open_price is None else open_price
    bar = Bar(symbol, start, start + 60, day, 60, opening, max(opening, close) + 1,
              min(opening, close) - 1, close, volume)
    return Event(f'{symbol}:{day}:{minute}', start + 60, bar)


class Trend(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], 60)

    def on_bar(self, ctx, bar):
        if not bar.is_final:
            return
        history = ctx.data.history(bar.symbol, 60, 2)
        if len(history) < 2:
            return
        symbol = ctx.data.resolve_contract(bar.symbol)
        target = ctx.params.get('size', 1) if history[-1].close > history[-2].close else 0
        ctx.orders.target_position(symbol, target, reason='trend')
        ctx.state['bars'] = ctx.state.get('bars', 0) + 1

    def on_roll(self, ctx, event, previous_contract):
        if previous_contract and ctx.position(previous_contract):
            ctx.orders.target_position(previous_contract, 0, reason='roll')


class Lookahead(Trend):
    def on_bar(self, ctx, bar):
        ctx.data.history(bar.symbol, 60, as_of=ctx.now + 1)


class Schedule(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], 60)

    def on_bar(self, ctx, bar):
        n = ctx.state.get('n', 0)
        ctx.state['n'] = n + 1
        targets = ctx.params['targets']
        if n < len(targets) and targets[n] is not None:
            ctx.orders.target_position(bar.symbol, targets[n])


class StrategySDKTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.future = Instrument('CFFEX.IM2611', 'future', .2, multiplier=200, margin_rate=.12,
                                 fees=Fees(per_unit=2, close_today_per_unit=5))

    def execute(self, strategy, instruments, events, **kwargs):
        return backtest.run(strategy, Dataset(instruments, events), output_dir=self.temp.name, **kwargs)

    def test_shared_strategy_future_backtest_matches_live_replay(self):
        continuous = Instrument('KQ.m@CFFEX.IM', 'continuous', .2)
        events = [Event('mapping', 1792373400, Roll(continuous.symbol, self.future.symbol, 1792373400, '2026-10-19'))]
        for minute, price in enumerate([8000, 8001, 8002, 8000, 7999]):
            events.extend([candle(self.future.symbol, minute, price), candle(continuous.symbol, minute, price)])
        dataset = Dataset([continuous, self.future], events)
        params = {'symbol': continuous.symbol}
        config = RunConfig(initial_cash=1_000_000)
        historical = backtest.run(Trend(), dataset, params=params, config=config, output_dir=self.temp.name)
        streamed = LiveRunner(Trend(), dataset.instruments, params=params, config=config,
                              mode='paper', output_dir=self.temp.name).run(iter(dataset.events))
        self.assertEqual(historical['status'], 'succeeded', historical['message'])
        for field in ('signals', 'fills', 'trades', 'metrics', 'equity_curve'):
            self.assertEqual(historical[field], streamed[field], field)
        self.assertEqual(historical['fills'][0]['symbol'], self.future.symbol)
        # Signal at the 2nd bar close fills no earlier than the 3rd bar open.
        self.assertEqual(historical['fills'][0]['time'], events[5].payload.time)
        self.assertAlmostEqual(historical['metrics']['total_pnl'], -607)

    def test_stock_cash_t_plus_one_and_lot_rules(self):
        stock = Instrument('SSE.600000', 'stock', .01, lot_size=100, t_plus_one=True, fees=Fees(minimum=5))
        events = [candle(stock.symbol, 0, 10), candle(stock.symbol, 1, 10), candle(stock.symbol, 2, 11),
                  candle(stock.symbol, 3, 12, day='2026-10-20', offset=86400),
                  candle(stock.symbol, 4, 13, day='2026-10-20', offset=86400)]
        result = self.execute(Schedule(), [stock], events, params={'symbol': stock.symbol, 'targets': [100, 0, None, 0]})
        self.assertEqual(result['status'], 'succeeded', result['message'])
        self.assertEqual(result['orders'][1]['reason'], 'T_PLUS_ONE')
        self.assertEqual(len(result['fills']), 2)
        self.assertAlmostEqual(result['metrics']['total_pnl'], 290)
        odd = self.execute(Schedule(), [stock], events, params={'symbol': stock.symbol, 'targets': [1]})
        self.assertEqual(odd['orders'][0]['reason'], 'LOT_SIZE')

    def test_fee_modes_apply_to_entries_exits_and_live_replay(self):
        # Keep both fee components nonzero to catch accidental double charging.
        for mode, expected in [('fixed', [6, 10]), ('rate', [40, 80]), ('combined', [46, 90])]:
            with self.subTest(mode=mode):
                item = Instrument(self.future.symbol, 'future', .2, multiplier=200, margin_rate=.12,
                                  fees=Fees(mode=mode, per_unit=3, rate=.001,
                                            close_today_per_unit=5, close_today_rate=.002))
                events = [candle(item.symbol, minute, 100) for minute in range(3)]
                config = RunConfig(initial_cash=1_000_000, slippage_ticks=0)
                params = {'symbol': item.symbol, 'targets': [2, 0]}
                result = self.execute(Schedule(), [item], events, params=params, config=config)
                self.assertEqual(result['status'], 'succeeded', result['message'])
                self.assertEqual([fill['fee'] for fill in result['fills']], expected)
                self.assertEqual(result['trades'][0]['fees'], sum(expected))
                self.assertEqual(result['metrics']['total_pnl'], -sum(expected))
                runner = LiveRunner(Schedule(), [item], params=params, config=config,
                                    mode='paper', output_dir=self.temp.name)
                runner.process(events[0])
                runner.process(events[1])
                restored = LiveRunner.restore(Schedule(), runner.checkpoint(), output_dir=self.temp.name)
                runner.finish('cancelled', 'restore fixture')
                streamed = restored.run(events[2:])
                for field in ('fills', 'trades', 'metrics'):
                    self.assertEqual(result[field], streamed[field], field)

    def test_fixed_fee_is_per_unit_and_close_today_zero_does_not_fall_back(self):
        for override, expected_close in [(None, 9), (0, 0), (5, 15)]:
            for price in (100, 8000):
                with self.subTest(override=override, price=price):
                    item = Instrument(self.future.symbol, 'future', .2, multiplier=200, margin_rate=.12,
                                      fees=Fees(mode='fixed', per_unit=3, rate=.1,
                                                close_today_per_unit=override, close_today_rate=.2))
                    for size in (3, -3):
                        self.assertEqual(PaperBroker._fee(item, size, price), 9)
                        self.assertEqual(PaperBroker._fee(item, size, price, closing_today=True), expected_close)
        stock = Instrument('SSE.600000', 'stock', .01, lot_size=100,
                           fees=Fees(mode='fixed', per_unit=.03))
        self.assertEqual(PaperBroker._fee(stock, 200, 10), 6)

    def test_fixed_fee_partial_fills_keep_minimum_and_sell_tax(self):
        item = Instrument(self.future.symbol, 'future', .2, multiplier=200, margin_rate=.12,
                          fees=Fees(mode='fixed', per_unit=2, rate=.1, minimum=5, sell_tax_rate=.001))
        # The two one-lot entry fills each incur the minimum; FIFO closes do too.
        events = [candle(item.symbol, minute, 100, volume=1) for minute in range(5)]
        result = self.execute(Schedule(), [item], events,
                              params={'symbol': item.symbol, 'targets': [2, None, 0]},
                              config=RunConfig(initial_cash=1_000_000, slippage_ticks=0, participation_rate=1))
        self.assertEqual(result['status'], 'succeeded', result['message'])
        self.assertEqual([fill['quantity'] for fill in result['fills']], [1, 1, -1, -1])
        self.assertEqual([fill['fee'] for fill in result['fills']], [5, 5, 25, 25])
        self.assertEqual(result['metrics']['total_pnl'], -60)
        rejected = self.execute(Schedule(), [item], events,
                                params={'symbol': item.symbol, 'targets': [1]},
                                config=RunConfig(initial_cash=2404, slippage_ticks=0, participation_rate=1))
        self.assertEqual(rejected['orders'][0]['reason'], 'INSUFFICIENT_FUNDS')
        self.assertEqual(rejected['fills'], [])

    def test_fee_mode_validation_and_legacy_combined_default(self):
        self.assertEqual(Fees().mode, 'combined')
        for mode in ('unknown', '', None):
            with self.assertRaisesRegex(ValueError, 'Invalid fee mode'):
                Fees(mode=mode)
        for fields in ({'per_unit': -1}, {'rate': float('nan')}, {'close_today_per_unit': -1}):
            with self.assertRaisesRegex(ValueError, 'Invalid fee'):
                Fees(mode='fixed', **fields)

    def test_stock_and_commodity_use_the_same_strategy(self):
        for item, size in [(Instrument('SZSE.000001', 'stock', .01, lot_size=100), 100),
                           (Instrument('SHFE.rb2611', 'future', 1, multiplier=10, margin_rate=.15), 1)]:
            events = [candle(item.symbol, i, p, day=f'2026-10-{19 + i}' if item.kind == 'stock' else '2026-10-19',
                             offset=i * 86400 if item.kind == 'stock' else 0)
                      for i, p in enumerate([10, 11, 12, 10, 9])]
            dataset = Dataset([item], events)
            params = {'symbol': item.symbol, 'size': size}
            a = backtest.run(Trend(), dataset, params=params, output_dir=self.temp.name)
            b = LiveRunner(Trend(), [item], params=params, mode='paper', output_dir=self.temp.name).run(events)
            self.assertEqual(a['status'], 'succeeded', a['message'])
            self.assertEqual(a['fills'], b['fills'])
            self.assertTrue(a['trades'])

    def test_future_data_is_rejected_and_failure_saved(self):
        result = self.execute(Lookahead(), [self.future], [candle(self.future.symbol, 0, 8000)], params={'symbol': self.future.symbol})
        self.assertEqual(result['status'], 'failed')
        self.assertIn('Future data', result['message'])
        self.assertTrue((Path(result['artifacts']) / 'result.json').exists())
        self.assertTrue((Path(result['artifacts']) / 'dataset.json').exists())

    def test_main_contract_roll_does_not_relabel_old_positions(self):
        main = Instrument('KQ.m@SHFE.rb', 'continuous', 1)
        old = Instrument('SHFE.rb2610', 'future', 1, multiplier=10, margin_rate=.1)
        new = Instrument('SHFE.rb2701', 'future', 1, multiplier=10, margin_rate=.1)
        start = 1792373400
        events = [Event('r1', start, Roll(main.symbol, old.symbol, start, '2026-10-19'))]
        for n, price in enumerate([100, 101, 102]):
            events.extend([candle(old.symbol, n, price), candle(main.symbol, n, price)])
        events.append(Event('r2', start + 180, Roll(main.symbol, new.symbol, start + 180, '2026-10-19')))
        events.extend([candle(old.symbol, 3, 103), candle(new.symbol, 3, 110), candle(main.symbol, 3, 110),
                       candle(new.symbol, 4, 111), candle(main.symbol, 4, 111)])
        result = self.execute(Trend(), [main, old, new], events, params={'symbol': main.symbol})
        self.assertEqual(result['status'], 'succeeded', result['message'])
        self.assertEqual([fill['symbol'] for fill in result['fills']], [old.symbol, old.symbol, new.symbol])

    def test_no_mapping_never_uses_current_contract(self):
        main = Instrument('KQ.m@CFFEX.IM', 'continuous', .2)
        result = self.execute(Trend(), [main, self.future], [candle(main.symbol, 0, 8000), candle(main.symbol, 1, 8001)], params={'symbol': main.symbol})
        self.assertEqual(result['status'], 'failed')
        self.assertIn('point-in-time', result['message'])

    def test_duplicate_and_correction_do_not_retrigger_signals(self):
        events = [candle(self.future.symbol, i, 8000 + i) for i in range(3)]
        runner = LiveRunner(Trend(), [self.future], params={'symbol': self.future.symbol}, output_dir=self.temp.name)
        runner.process(events[0])
        runner.process(events[1])
        runner.process(events[1])
        corrected = candle(self.future.symbol, 1, 7999)
        runner.process(Event('correction', events[1].available_at + 1, corrected.payload))
        self.assertEqual(len(runner.signals), 1)
        runner.process(events[2])
        result = runner.finish()
        self.assertEqual(len(result['signals']), 2)
        self.assertEqual(len(result['fills']), 0, 'monitor mode cannot fabricate trades')

    def test_checkpoint_restores_state_and_open_positions(self):
        events = [candle(self.future.symbol, i, p) for i, p in enumerate([8000, 8001, 8002, 8000, 7999])]
        config = RunConfig(initial_cash=1_000_000)
        params = {'symbol': self.future.symbol}
        runner = LiveRunner(Trend(), [self.future], params=params, config=config, mode='paper', output_dir=self.temp.name)
        for event in events[:3]: runner.process(event)
        checkpoint = runner.checkpoint()
        restored = LiveRunner.restore(Trend(), checkpoint, output_dir=self.temp.name)
        runner.finish('cancelled', 'restart fixture')
        result = restored.run(events[2:])
        uninterrupted = LiveRunner(Trend(), [self.future], params=params, config=config, mode='paper', output_dir=self.temp.name).run(events)
        for field in ('signals', 'fills', 'trades', 'metrics'):
            self.assertEqual(result[field], uninterrupted[field], field)

    def test_finished_backtest_keeps_entry_fill_and_open_position_without_closed_trade(self):
        events = [candle(self.future.symbol, i, 8000 + i) for i in range(3)]
        result = self.execute(Schedule(), [self.future], events,
                              params={'symbol': self.future.symbol, 'targets': [1]},
                              config=RunConfig(initial_cash=1_000_000))
        self.assertEqual(result['status'], 'succeeded', result['message'])
        self.assertEqual(result['account']['positions'], {self.future.symbol: 1})
        self.assertEqual(len(result['fills']), 1)
        self.assertEqual(result['fills'][0]['offset'], 'open')
        self.assertEqual(result['trades'], [])
        self.assertEqual(result['metrics']['trade_count'], 0)
        saved = json.loads((Path(result['artifacts']) / 'result.json').read_text())
        self.assertEqual(saved['account']['positions'], result['account']['positions'])
        self.assertEqual(saved['fills'], result['fills'])

    def test_cancellation_persists_a_run(self):
        stop = StopEvent()
        stop.set()
        result = self.execute(Trend(), [self.future], [candle(self.future.symbol, 0, 8000)],
                              params={'symbol': self.future.symbol}, stop_event=stop)
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(result['message'], '用户中止了操作')

    def test_partial_fills_volume_zero_and_margin_rejection(self):
        events = [candle(self.future.symbol, i, 8000, volume=v) for i, v in enumerate([100, 0, 1, 1])]
        result = self.execute(Schedule(), [self.future], events, config=RunConfig(initial_cash=1_000_000),
                              params={'symbol': self.future.symbol, 'targets': [2]})
        self.assertEqual([fill['quantity'] for fill in result['fills']], [1, 1])
        rejected = self.execute(Schedule(), [self.future], events, config=RunConfig(initial_cash=1000),
                                params={'symbol': self.future.symbol, 'targets': [2]})
        self.assertEqual(rejected['orders'][0]['reason'], 'INSUFFICIENT_FUNDS')
        self.assertEqual(rejected['fills'], [])

    def test_warmup_excluded_from_trades_and_metrics(self):
        events = [candle(self.future.symbol, i, 8000 + i) for i in range(4)]
        result = self.execute(Trend(), [self.future], events, config=RunConfig(start=events[2].available_at, initial_cash=1_000_000),
                              params={'symbol': self.future.symbol})
        self.assertEqual(result['signals'][0]['time'], events[2].available_at)
        self.assertEqual(len(result['equity_curve']), 2)

    def test_dataset_round_trip_and_statistics_json(self):
        dataset = Dataset([self.future], [candle(self.future.symbol, 0, 8000)], metadata={'source': 'fixture'})
        path = Path(self.temp.name) / 'input.json'
        dataset.save(path)
        self.assertEqual(Dataset.load(path).fingerprint, dataset.fingerprint)
        result = self.execute(Schedule(), [self.future], dataset.events, params={'symbol': self.future.symbol, 'targets': []})
        json.dumps(result, allow_nan=False)
        self.assertIsNone(result['metrics']['profit_factor'])
        self.assertIsNone(result['metrics']['benchmark_return'])
        self.assertEqual(result['monthly_returns'][0]['return'], 0)


if __name__ == '__main__': unittest.main()
