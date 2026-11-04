import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk'))
sys.path.insert(0, str(ROOT / 'worker'))
from quant_sdk.execution import Lot
from position_valuation import open_valuation, exit_valuation
from strategy_monitor import SignalOutput
from tq_monitor_history import NativeSignalOutput


class ValuationTests(unittest.TestCase):
    def runner(self, quantity=2, points=False):
        lot = Lot('IM', quantity, 100, 110, 1000, '2026-11-04', 4, 'entry')
        broker = SimpleNamespace(lots=[lot], points=points, marks={'IM': 120}, position=lambda _: quantity)
        data = SimpleNamespace(instrument=lambda _: SimpleNamespace(multiplier=200), quote=lambda _: None,
                               history=lambda *_: [SimpleNamespace(close=120, end_time=1100)])
        return SimpleNamespace(broker=broker, data=data), lot

    def test_long_short_points_and_settlement_basis(self):
        for quantity, points, expected in [(2, False, 7996), (-2, False, -8004), (2, True, 36)]:
            runner, lot = self.runner(quantity, points)
            result = open_valuation(runner, lot)
            self.assertEqual(result['unrealized_pnl'], expected)
            self.assertEqual(result['pnl_multiplier'], 1 if points else 200)

    def test_native_uses_quote_and_missing_price_is_not_zero_profit(self):
        runner, lot = self.runner()
        runner.broker.quote = SimpleNamespace(last_price=125)
        self.assertEqual(open_valuation(runner, lot)['unrealized_pnl'], 9996)
        runner.broker.quote.last_price = float('nan')
        runner.broker.marks = {}
        self.assertIsNone(open_valuation(runner, lot)['unrealized_pnl'])

    def test_live_quote_updates_between_candles_but_stale_quote_does_not_replace_bar(self):
        runner, lot = self.runner()
        runner.data.quote = lambda _: SimpleNamespace(last=125, time=1101)
        self.assertEqual(open_valuation(runner, lot)['unrealized_pnl'], 9996)
        runner.data.quote = lambda _: SimpleNamespace(last=125, time=1099)
        self.assertEqual(open_valuation(runner, lot)['unrealized_pnl'], 7996)

    def test_reduction_reversal_and_risk_match_only_closed_quantity(self):
        runner, _ = self.runner()
        signal = {'symbol': 'IM', 'kind': 'target_position', 'target': 1}
        self.assertEqual(exit_valuation(runner, signal, 'long', 120)['value'], 3998)
        self.assertEqual(exit_valuation(runner, {**signal, 'target': -1}, 'long', 120)['value'], 7996)
        risk = {'symbol': 'IM', 'kind': 'risk_exit', 'entry_signal_id': 'another-entry'}
        self.assertIsNone(exit_valuation(runner, risk, 'long', 120))
        self.assertIsNone(exit_valuation(runner, signal, 'unknown', 120))
        self.assertIsNone(exit_valuation(runner, signal, 'long', float('nan')))

    def test_multi_lot_fifo_and_reference_pnl_reaches_exit_signal(self):
        runner, _ = self.runner()
        runner.broker.lots.append(Lot('IM', 1, 110, 110, 1001, '2026-11-04', 2, 'second'))
        signal = {'id': 'exit', 'time': 2000, 'symbol': 'IM', 'kind': 'target_position', 'target': 1}
        records = []
        client = SimpleNamespace(call=lambda _, **value: records.append(value['signal']))
        output = SignalOutput(client, 0, targets={'IM': 3})
        output.runner = runner
        output({'type': 'signal', 'payload': signal})
        self.assertEqual(records[0]['pnl'], {'value': 7996, 'unit': 'currency', 'basis': 'estimate'})

    def test_native_fill_delivers_realized_pnl_including_zero(self):
        runner, _ = self.runner()
        records = []
        history = SimpleNamespace(signal=lambda value: records.append(value), call=lambda *_args, **_kwargs: None)
        output = NativeSignalOutput(history, 0)
        output.history, output.runner = history, runner
        for value in (192, 0, -8):
            output({'type': 'fill', 'payload': {'native_trade_id': str(value), 'offset': 'close',
                'quantity': -1, 'symbol': 'IM', 'time': 2000, 'price': 120, 'net_pnl': value}})
            self.assertEqual(records[-1]['pnl'], {'value': value, 'unit': 'currency', 'basis': 'realized'})


if __name__ == '__main__':
    unittest.main()
