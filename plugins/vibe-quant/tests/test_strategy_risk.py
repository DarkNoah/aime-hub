import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Dataset, Event, Instrument, LiveRunner, Quote, RiskLevels, RunConfig, Strategy, backtest
from test_strategy_sdk import candle


class DynamicRisk(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], 60)

    def on_bar(self, ctx, bar):
        n = ctx.state.get('n', 0)
        ctx.state['n'] = n + 1
        if n in (0, 4):
            ctx.state['entry'] = ctx.orders.target_position(bar.symbol, 1 if n == 0 else -1)
        if n == 3:
            ctx.orders.target_position(bar.symbol, 0)
            return RiskLevels(bar.symbol, entry_id=ctx.state['entry'])
        return RiskLevels(bar.symbol, entry_id=ctx.state['entry'], stop_loss=bar.close - 5,
                          take_profit=bar.close + 10 if n != 2 else None)


class FillRisk(DynamicRisk):
    def on_fill(self, ctx, fill):
        if fill['offset'] == 'open':
            # All currently open lots can be updated without passing an ID.
            ctx.set_risk_levels(fill['symbol'], stop_loss=fill['price'] - 1)
            # Multiple calculations at the same clock are retained in order.
            return [RiskLevels(fill['symbol'], take_profit=fill['price'] + 1),
                    RiskLevels(fill['symbol'], stop_loss=fill['price'] - 1)]


class InvalidRisk(DynamicRisk):
    def on_bar(self, ctx, bar):
        return RiskLevels(bar.symbol, stop_loss=90, entry_id='unrelated-entry')


class LegacyReturn(DynamicRisk):
    def on_bar(self, ctx, bar):
        return ctx.orders.target_position(bar.symbol, 1)


class QuoteRisk(DynamicRisk):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'])

    def on_quote(self, ctx, quote):
        return RiskLevels(quote.symbol, entry_id=ctx.state['entry'], stop_loss=quote.last - 5)


class StrategyRiskTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.item = Instrument('CFFEX.IM2612', 'future', .2, multiplier=200, margin_rate=.12)
        self.events = [candle(self.item.symbol, n, 100 + n) for n in range(7)]
        self.kwargs = dict(params={'symbol': self.item.symbol}, config=RunConfig(initial_cash=1_000_000),
                           output_dir=self.temp.name)

    def test_dynamic_snapshots_match_backtest_paper_monitor_and_exports(self):
        result = backtest.run(DynamicRisk(), Dataset([self.item], self.events), **self.kwargs)
        self.assertEqual(result['status'], 'succeeded', result['message'])
        records = result['risk_levels']
        self.assertEqual(len(records), len(self.events))
        self.assertEqual([r['time'] for r in records], [e.available_at for e in self.events])
        self.assertEqual([r['stop_loss'] for r in records[:4]], [95, 96, 97, None])
        self.assertIsNone(records[2]['take_profit'])
        self.assertEqual(records[0]['entry_signal_id'], result['trades'][0]['entry_signal_id'])
        self.assertNotEqual(records[4]['entry_signal_id'], records[0]['entry_signal_id'])
        self.assertEqual(json.loads((Path(result['artifacts']) / 'result.json').read_text())['risk_levels'], records)
        for mode in ('paper', 'monitor'):
            outputs = []
            streamed = LiveRunner(DynamicRisk(), [self.item], mode=mode, on_event=outputs.append,
                                  **self.kwargs).run(self.events)
            self.assertEqual(streamed['risk_levels'], records)
            self.assertEqual([o['payload'] for o in outputs if o['type'] == 'risk_levels'], records)

    def test_fill_time_is_calculation_time_not_backdated_execution_time(self):
        result = backtest.run(FillRisk(), Dataset([self.item], self.events), **self.kwargs)
        self.assertEqual(result['status'], 'succeeded', result['message'])
        at_fill = [r for r in result['risk_levels'] if r['time'] == self.events[1].available_at]
        self.assertEqual(len(at_fill), 4)
        self.assertEqual([r['stop_loss'] for r in at_fill], [100, None, 100, 96])
        self.assertEqual(len({r['id'] for r in at_fill}), 4)
        self.assertGreater(at_fill[0]['time'], result['fills'][0]['time'])

    def test_checkpoint_and_duplicate_events_preserve_complete_history(self):
        runner = LiveRunner(DynamicRisk(), [self.item], mode='paper', **self.kwargs)
        for event in self.events[:3]: runner.process(event)
        self.assertFalse(runner.process(self.events[2]))
        checkpoint = runner.checkpoint()
        restored = LiveRunner.restore(DynamicRisk(), checkpoint, output_dir=self.temp.name)
        runner.finish('cancelled')
        resumed = restored.run(self.events[2:])
        full = LiveRunner(DynamicRisk(), [self.item], mode='paper', **self.kwargs).run(self.events)
        self.assertEqual(resumed['risk_levels'], full['risk_levels'])
        self.assertEqual(resumed['trades'], full['trades'])

    def test_validation_rejects_nonfinite_prices_and_unrelated_entries(self):
        for value in (float('nan'), float('inf'), True):
            with self.assertRaises(ValueError): RiskLevels(self.item.symbol, stop_loss=value)
        result = backtest.run(InvalidRisk(), Dataset([self.item], self.events), **self.kwargs)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('must reference', result['message'])
        self.assertEqual(result['risk_levels'], [])

    def test_quote_calculations_emit_immediately_and_legacy_returns_still_work(self):
        outputs = []
        runner = LiveRunner(QuoteRisk(), [self.item], on_event=outputs.append, **self.kwargs)
        runner.process(self.events[0])
        quote = Quote(self.item.symbol, self.events[0].available_at + .5, '2026-10-19', last=111)
        runner.process(Event('q1', quote.time, quote))
        self.assertEqual(outputs[-1]['type'], 'risk_levels')
        self.assertEqual(outputs[-1]['payload']['time'], quote.time)
        self.assertEqual(outputs[-1]['payload']['stop_loss'], 106)
        runner.finish()
        legacy = backtest.run(LegacyReturn(), Dataset([self.item], self.events), **self.kwargs)
        self.assertEqual(legacy['status'], 'succeeded', legacy['message'])
        self.assertTrue(legacy['fills'])
        self.assertEqual(legacy['risk_levels'], [])


if __name__ == '__main__': unittest.main()
