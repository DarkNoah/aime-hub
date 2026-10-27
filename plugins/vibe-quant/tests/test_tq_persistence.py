"""Native accounting, pending-order recovery and fill notifications; no network."""
import contextlib
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
try:
    with contextlib.redirect_stdout(io.StringIO()):
        from tqsdk.objs import Quote
        from quant_sdk.tq_persistence import DurableTqSim, pack, unpack
except ModuleNotFoundError as error:
    if error.name == 'tqsdk':
        raise unittest.SkipTest('Native persistence tests require the plugin TqSdk environment')
    raise
from quant_sdk.tq_metrics import performance
from tq_monitor_history import NativeSignalOutput

SYMBOL = 'CFFEX.IM2611'
class PersistenceTests(unittest.TestCase):
    def make_sim(self):
        sim = DurableTqSim(10000, 'test')
        sim._current_datetime = '2026-10-19 09:31:00.000000'
        sim._trading_day_end = '2026-10-19 17:59:59.999999'
        sim._sim_trade._get_trade_timestamp = lambda: 1792373460000000000
        sim._sim_trade._is_in_trading_time = lambda quote: True
        quote = Quote(None)
        quote.update(datetime=sim._current_datetime, ins_class='FUTURE', volume_multiple=10,
            price_tick=1, last_price=100, bid_price1=99, ask_price1=101,
            min_limit_order_volume=1, max_limit_order_volume=1000,
            user_margin=100, user_commission=2, margin=100, commission=2)
        sim._sim_trade.update_quotes(SYMBOL, {'quotes': {SYMBOL: quote}})
        return sim, quote

    def order(self, sim, order_id, price, direction='BUY', offset='OPEN'):
        return sim._sim_trade.insert_order(SYMBOL, dict(aid='insert_order', order_id=order_id, exchange_id='CFFEX',
            instrument_id='IM2611', user_id='test', direction=direction, offset=offset, volume=1,
            price_type='LIMIT', limit_price=price, time_condition='GFD', volume_condition='ANY'))

    def test_native_portfolio_and_pending_order_survive_json_restore(self):
        sim, quote = self.make_sim()
        _, filled = self.order(sim, 'filled', 101)
        self.order(sim, 'pending', 98)
        api = SimpleNamespace(get_order=lambda: {**{v['order_id']: v for v in filled}, 'queued': {'status': 'ALIVE'}})
        saved = json.loads(json.dumps(sim.snapshot(api), allow_nan=False))
        restored = DurableTqSim(10000, 'test', saved)
        self.assertEqual(pack(restored._sim_trade._account), pack(sim._sim_trade._account))
        self.assertEqual(restored._sim_trade._positions[SYMBOL]['pos_long_today'], 1)
        self.assertIn('pending', restored._sim_trade._orders[SYMBOL])
        snapshot = restored._sim_trade.init_snapshot()['trade'][restored._account_key]
        self.assertEqual(snapshot['orders']['filled']['status'], 'FINISHED')
        self.assertEqual(len(snapshot['trades']), 1)
        self.assertNotIn('queued', snapshot['orders'])
        self.assertEqual(restored._sim_trade._account['commission'], 2)
        self.assertEqual(restored._sim_trade._account['margin'], 100)
        # API shutdown must not move today's positions to yesterday or cancel orders.
        restored._handle_stat_report()
        self.assertEqual(restored._sim_trade._positions[SYMBOL]['pos_long_today'], 1)
        self.assertIn('pending', restored._sim_trade._orders[SYMBOL])

    def test_native_metrics_and_restore_use_same_account(self):
        sim, quote = self.make_sim()
        self.order(sim, 'filled', 101)
        result = performance(sim, quote)
        self.assertEqual(result['metrics_source'], 'TqSim/TqReport')
        self.assertEqual(result['metrics']['commission'], 2)
        self.assertEqual(result['native_metrics']['balance'], sim._sim_trade._account['balance'])
        self.assertIsNone(result['metrics']['profit_factor'])

    def test_checkpoint_rejects_wrong_identity_and_roundtrips_nonfinite_values(self):
        sim, _ = self.make_sim()
        saved = sim.snapshot(SimpleNamespace(get_order=lambda: {}))
        with self.assertRaises(ValueError): DurableTqSim(10000, 'another-account', saved)
        saved['sdk'] = 'future-version'
        with self.assertRaises(ValueError): DurableTqSim(10000, 'test', saved)
        self.assertEqual(unpack(pack(float('inf'))), float('inf'))

    def test_signal_only_after_fill_and_notification_respects_cutoff(self):
        class History:
            def __init__(self): self.signals, self.notifications = [], []
            def signal(self, value): self.signals.append(value)
            def call(self, kind, **value): self.notifications.append((kind, value))
        history = History()
        output = NativeSignalOutput(history, 100)
        output.history = history
        output.runner = SimpleNamespace(broker=SimpleNamespace(position=lambda symbol: 1))
        output({'type': 'signal', 'payload': {}})
        self.assertEqual(history.signals, [])
        output({'type': 'fill', 'payload': dict(offset='open', quantity=1, native_trade_id='t1',
                symbol=SYMBOL, time=101, price=101)})
        self.assertEqual(history.signals[0]['type'], 'entry')
        self.assertEqual(history.signals[0]['id'], 'native:t1')
        self.assertEqual(len(history.notifications), 1)
        output({'type': 'fill', 'payload': dict(offset='close', quantity=-1, native_trade_id='t2',
                symbol=SYMBOL, time=99, price=101)})
        self.assertEqual(history.signals[-1]['side'], 'long')
        self.assertEqual(history.signals[-1]['type'], 'exit')
        self.assertEqual(len(history.notifications), 1)

class RestoreIntentTests(unittest.TestCase):
    def test_queued_order_restores_original_identity_and_cancellation_is_not_reopened(self):
        import test_tq_backtest as fixture
        from quant_sdk.tq_restore import snapshot_runner, restore_runner, restore_broker
        from quant_sdk.tq_broker import TqBroker
        case = fixture.TqBrokerTests()
        case.setUp()
        restored = None
        try:
            case.target(1)
            case.broker.advance()
            native_id = case.api.orders[0].order_id
            saved = snapshot_runner(case.runner, 3)
            restored = restore_runner(fixture.IdleStrategy(), saved, Path(case.tmp.name) / 'resumed', None)
            api = fixture.FakeApi()
            api.get_order = lambda: {o.order_id: o for o in api.orders}
            restored.broker = TqBroker(restored, api, api, api.quote, case.calendar)
            restore_broker(restored, saved, api)
            self.assertEqual([o.order_id for o in api.orders], [native_id])
            api.fill(api.orders[0])
            restored.broker.sync()
            restored.broker.sync()
            self.assertEqual(len(restored.broker.fills), 1)
            # A queued cancellation is retried; a missing cancelled intent is not reissued.
            saved['runner']['broker']['orders'][0]['status'] = 'cancelled'
            api.orders.clear()
            restore_broker(restored, saved, api)
            self.assertEqual(api.orders, [])
        finally:
            if restored: restored.journal.close()
            case.tearDown()

if __name__ == '__main__': unittest.main()
