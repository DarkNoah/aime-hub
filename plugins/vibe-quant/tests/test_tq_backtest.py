"""Public-interface fakes test accounting/clock contracts without provider access."""
from datetime import datetime
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Strategy, Instrument, RunConfig
from quant_sdk.calendar import TradingCalendar
from quant_sdk.models import Bar
from quant_sdk.runtime import Runner
from quant_sdk.tq_broker import TqBroker
from quant_sdk.tq_backtest import ReplayFeed, run

TZ = ZoneInfo('Asia/Shanghai')
START = datetime(2026, 10, 19, 9, 30, tzinfo=TZ).timestamp()


class Entity(dict):
    def __getattr__(self, name):
        return self[name]

    def __setattr__(self, name, value):
        self[name] = value


class Frame:
    """Only the DataFrame surface used by the adapter, with real id ordering."""
    def __init__(self, rows):
        self.rows = rows

    @property
    def empty(self):
        return not self.rows

    @property
    def iloc(self):
        return self

    def __getitem__(self, key):
        return Frame(self.rows[key]) if isinstance(key, slice) else self.rows[key]

    def __len__(self):
        return len(self.rows)

    def to_dict(self, _):
        return self.rows


class IdleStrategy(Strategy):
    pass


class RoundTrip(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], 60)

    def on_bar(self, ctx, bar):
        self.count = getattr(self, 'count', 0) + 1
        ctx.orders.target_position(bar.symbol, 1 if self.count == 1 else 0)


class Finished(Exception):
    pass


class FakeApi:
    def __init__(self, symbol='CFFEX.IM2611'):
        self.symbol = symbol
        self.quote = Entity(ins_class='FUTURE', datetime='2026-10-19 09:30:00.000000',
            price_tick=1., volume_multiple=10., last_price=100., ask_price1=101., bid_price1=99.,
            max_limit_order_volume=1000, upper_limit=200., lower_limit=1.)
        self.position = Entity(pos_long=0, pos_short=0, pos_long_his=0, pos_long_today=0,
                               pos_short_his=0, pos_short_today=0)
        self.account = Entity(balance=10000., float_profit=0., margin=0., available=10000., frozen_margin=0.)
        self.orders, self.cancelled = [], []
        self.commission, self.margin = 2., 100.
        self.frame, self.steps = Frame([]), []
        self.open_price, self.realized, self.fees = None, 0., 0.

    @property
    def tqsdk_stat(self):
        return {'balance': self.account.balance, 'init_balance': 10000, 'ror': self.account.balance / 10000 - 1}

    def get_position(self, _): return self.position
    def get_account(self): return self.account
    def get_quote(self, _): return self.quote
    def get_commission(self, _): return self.commission
    def get_margin(self, _): return self.margin
    def set_commission(self, _, value): self.commission = value
    def set_margin(self, _, value): self.margin = value
    def get_kline_serial(self, *_args, **_kwargs): return self.frame
    def get_trading_calendar(self, *_):
        return Frame([{'date': datetime(2026, 10, day), 'trading': True} for day in (19, 20, 21)])

    def insert_order(self, symbol, **args):
        order = Entity(order_id=args.pop('order_id', f'order-{len(self.orders)}'), status='ALIVE', volume_orign=args['volume'],
            volume_left=args['volume'], last_msg='', trade_records={}, symbol=symbol, **args)
        self.orders.append(order)
        return order

    def cancel_order(self, order):
        self.cancelled.append(order.order_id)

    def fill(self, order, price=None, now=START + 60, reject=False):
        order.status = 'FINISHED'
        if reject:
            order.last_msg = '资金不足'
            return
        price = order.limit_price if price is None else price
        size = order.volume
        trade = Entity(order_id=order.order_id, trade_id=f'fill:{order.order_id}', volume=size,
            direction=order.direction, offset=order.offset, price=price, commission=self.commission * size,
            trade_date_time=int(now * 1e9))
        order.trade_records[trade.trade_id] = trade
        order.volume_left = 0
        side = 'long' if (order.direction == 'BUY') == (order.offset == 'OPEN') else 'short'
        sign = 1 if order.offset == 'OPEN' else -1
        self.position[f'pos_{side}'] += sign * size
        bucket = 'today' if order.offset in ('OPEN', 'CLOSETODAY') or self.position[f'pos_{side}_his'] == 0 else 'his'
        self.position[f'pos_{side}_{bucket}'] += sign * size
        self.fees += trade.commission
        if order.offset == 'OPEN':
            self.open_price = price
        else:
            self.realized += (price - self.open_price) * size * 10 * (1 if side == 'long' else -1)
        self.mark()

    def mark(self):
        net = self.position.pos_long - self.position.pos_short
        self.account.float_profit = (self.quote.last_price - (self.open_price or self.quote.last_price)) * net * 10
        self.account.balance = 10000 + self.realized + self.account.float_profit - self.fees
        self.account.margin = abs(net) * self.margin
        self.account.available = self.account.balance - self.account.margin

    def wait_update(self, **_):
        for order in self.orders:
            if order.status != 'FINISHED':
                self.fill(order, now=datetime.fromisoformat(self.quote.datetime).replace(tzinfo=TZ).timestamp())
                return True
        if not self.steps:
            raise Finished()
        timestamp, rows, price = self.steps.pop(0)
        self.quote.datetime = datetime.fromtimestamp(timestamp, TZ).strftime('%Y-%m-%d %H:%M:%S.%f')
        self.quote.last_price, self.quote.bid_price1, self.quote.ask_price1 = price, price - 1, price + 1
        self.frame.rows = rows
        self.mark()
        return True


def row(index, start, price, volume=10):
    return {'id': index, 'datetime': int(start * 1e9), 'open': price, 'high': price + 2,
            'low': price - 2, 'close': price, 'volume': volume}


class TqBrokerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.api = FakeApi()
        self.calendar = TradingCalendar({'2026-10-19': True, '2026-10-20': True})
        self.runner = Runner(IdleStrategy(), [Instrument(self.api.symbol, 'future', 1, multiplier=10, margin_rate=.1)],
            config=RunConfig(initial_cash=10000, slippage_ticks=1), output_dir=self.tmp.name)
        self.broker = self.runner.broker = TqBroker(self.runner, self.api, self.api, self.api.quote, self.calendar)
        self.runner.data.now = START
        self.runner.context.event_id = 'initial'
        self.runner.context.trading_day = '2026-10-19'
        self.runner.context.warming_up = False

    def tearDown(self):
        self.runner.journal.close()
        self.tmp.cleanup()

    def target(self, quantity):
        self.runner.context.event_id = str(len(self.broker.orders))
        return self.runner.context.orders.target_position(self.api.symbol, quantity)

    def open(self, size=1):
        order = self.target(size)
        self.broker.advance()
        self.api.fill(self.api.orders[-1], 100)
        self.broker.sync()
        return order

    def test_no_synthetic_fills_and_native_account_is_authoritative(self):
        self.target(2)
        self.broker.advance()
        self.assertEqual(self.broker.fills, [])
        self.assertEqual(self.api.orders[0].limit_price, 102)
        self.api.fill(self.api.orders[0], 102)
        self.api.account.balance, self.api.account.available = 9876, 9123
        self.broker.sync()
        self.broker.sync()
        self.assertEqual(len(self.broker.fills), 1)
        self.assertEqual(self.broker.fills[0]['fee'], 4)
        self.assertEqual(self.broker.account()['equity'], 9876)
        self.assertEqual(self.broker.account()['available'], 9123)
        self.assertEqual(self.broker.position(self.api.symbol), 2)
        self.assertEqual(self.broker.children, {})

    def test_reversal_closes_then_opens_and_reports_actual_fees(self):
        self.open(2)
        self.target(-1)
        self.broker.advance()
        close = self.api.orders[-1]
        self.assertEqual((close.direction, close.offset, close.volume), ('SELL', 'CLOSE', 2))
        self.broker.advance()
        self.assertEqual(len(self.api.orders), 2)
        self.api.fill(close, 110)
        self.broker.sync()
        self.assertEqual(self.broker.trades[0]['gross_pnl'], 200)
        self.assertEqual(self.broker.trades[0]['net_pnl'], 192)
        self.broker.advance()
        self.assertEqual((self.api.orders[-1].offset, self.api.orders[-1].volume), ('OPEN', 1))

    def test_cancel_fill_race_is_accounted_before_replacement(self):
        self.target(2)
        self.broker.advance()
        old = self.api.orders[0]
        self.target(0)
        self.broker.advance()
        self.assertEqual(len(self.api.orders), 1)
        self.api.fill(old, 100)
        self.broker.sync()
        self.broker.advance()
        self.assertEqual(len(self.broker.fills), 1)
        self.assertEqual((self.api.orders[-1].offset, self.api.orders[-1].volume), ('CLOSE', 2))

    def test_rejection_is_terminal_and_does_not_invent_trades(self):
        self.target(100)
        self.broker.advance()
        self.api.fill(self.api.orders[-1], reject=True)
        self.broker.sync()
        self.broker.advance()
        self.assertEqual(self.broker.orders[0].status, 'rejected')
        self.assertEqual(self.broker.orders[0].reason, '资金不足')
        self.assertEqual(self.broker.trades, [])
        self.assertEqual(len(self.api.orders), 1)

    def test_risk_uses_quote_trigger_and_waits_for_native_fill(self):
        entry = self.open()
        self.runner.context.set_risk_levels(self.api.symbol, entry_id=entry, stop_loss=95, take_profit=110)
        self.broker.on_bar(Bar(self.api.symbol, START, START + 60, '2026-10-19', 60, 100, 120, 90, 100, 20))
        self.assertEqual(len(self.api.orders), 1)
        self.runner.data.now = START + 120
        self.api.quote.last_price = 94
        self.broker.check_risk()
        self.broker.advance()
        self.assertEqual(self.broker.trades, [])
        self.api.fill(self.api.orders[-1], 93, now=START + 120)
        self.broker.sync()
        self.assertEqual(self.broker.trades[0]['exit_reason'], 'stop_loss')
        self.assertEqual(self.broker.trades[0]['exit_price'], 93)
        self.assertEqual(self.broker.trades[0]['risk_level_id'], self.runner.risk_levels[0]['id'])

    def test_shfe_closes_yesterday_before_today(self):
        self.api.symbol = self.broker.symbol = 'SHFE.rb2701'
        self.runner.data._instruments = {self.api.symbol: Instrument(self.api.symbol, 'future', 1, multiplier=10, margin_rate=.1)}
        self.open()
        self.broker.lots[0].trading_day = '2026-10-16'
        self.api.position.pos_long_his, self.api.position.pos_long_today = 1, 0
        self.target(2)
        self.broker.advance()
        self.api.fill(self.api.orders[-1], 100)
        self.broker.sync()
        self.target(0)
        self.broker.advance()
        self.assertEqual((self.api.orders[-1].offset, self.api.orders[-1].volume), ('CLOSE', 1))
        self.api.fill(self.api.orders[-1], 101)
        self.broker.sync()
        self.broker.advance()
        self.assertEqual((self.api.orders[-1].offset, self.api.orders[-1].volume), ('CLOSETODAY', 1))

    def test_missing_opposite_quote_keeps_order_pending(self):
        self.target(1)
        self.api.quote.ask_price1 = float('nan')
        self.broker.advance()
        self.assertEqual(self.api.orders, [])
        self.assertEqual(self.broker.orders[0].status, 'pending')

    def test_feed_withholds_open_candle_and_includes_final_candle_without_next_open(self):
        self.runner.config = RunConfig(start=START)
        feed = ReplayFeed(self.api, self.runner, self.api.symbol, 60, self.calendar)
        feed.subscribe()
        self.api.frame.rows = [row(0, START, 100)]
        self.assertEqual(feed.events(START + 30), [])
        events = feed.events(START + 60 - .000001)
        self.assertEqual(len(events), 1)
        self.assertFalse(events[0][1])
        self.assertLessEqual(events[0][0].payload.end_time, events[0][0].available_at)
        self.assertEqual(feed.events(START + 60), [])

    def test_complete_run_exports_compatible_result_and_frozen_candles(self):
        self.api.frame.rows = [row(0, START, 100, volume=0)]
        self.api.steps = [
            (START + 60 - .000001, [row(0, START, 100)], 100),
            (START + 60, [row(0, START, 100), row(1, START + 60, 110, volume=0)], 110),
            (START + 120 - .000001, [row(0, START, 100), row(1, START + 60, 110)], 110),
        ]
        config = dict(symbol=self.api.symbol, duration=60, start=START, end=START + 120, initial_cash=10000,
            slippage_ticks=0, annualization=252, risk_free_rate=0, benchmark_symbol=None, parameters={})
        result = run(RoundTrip(), self.api, self.api, config, output_dir=Path(self.tmp.name) / 'artifacts',
            stop_event=threading.Event(), finished_exception=Finished, sdk_version='test')
        self.assertEqual(result['status'], 'succeeded', result['message'])
        self.assertEqual(result['backtest_engine'], 'tqsdk')
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['net_pnl'], 76)
        self.assertEqual(result['metrics']['total_pnl'], 76)
        self.assertEqual(result['metrics']['final_equity'], result['account']['equity'])
        dataset = json.loads((Path(self.tmp.name) / 'dataset.json').read_text())
        self.assertEqual(len([e for e in dataset['events'] if e['type'] == 'bar']), 2)
        manifest = json.loads((Path(result['artifacts']) / 'manifest.json').read_text())
        self.assertTrue(manifest['data_snapshot_hash'])
        self.assertEqual(manifest['tq_rules']['commission_per_lot'], 2)

    def test_cancelled_run_closes_with_cancelled_status(self):
        stop = threading.Event()
        stop.set()
        config = dict(symbol=self.api.symbol, duration=60, start=START, end=START + 120, initial_cash=10000,
            slippage_ticks=0, annualization=252, risk_free_rate=0, benchmark_symbol=None, parameters={})
        result = run(IdleStrategy(), self.api, self.api, config, output_dir=Path(self.tmp.name) / 'artifacts',
            stop_event=stop, finished_exception=Finished, sdk_version='test')
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(result['message'], '用户中止了操作')

    def test_final_update_exports_last_bar_without_submitting_after_provider_finishes(self):
        def final_update(**_):
            self.api.quote.datetime = '2026-10-19 09:30:59.999999'
            self.api.frame.rows = [row(0, START, 100)]
            raise Finished()
        self.api.wait_update = final_update
        config = dict(symbol=self.api.symbol, duration=60, start=START, end=START + 60, initial_cash=10000,
            slippage_ticks=0, annualization=252, risk_free_rate=0, benchmark_symbol=None, parameters={})
        result = run(RoundTrip(), self.api, self.api, config, output_dir=Path(self.tmp.name) / 'artifacts',
            stop_event=threading.Event(), finished_exception=Finished, sdk_version='test')
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(self.api.orders, [])
        self.assertEqual(result['orders'][0]['status'], 'cancelled')

    def test_error_in_final_bar_callback_preserves_failed_report(self):
        class Broken(Strategy):
            def on_start(self, ctx):
                ctx.data.subscribe(ctx.params['symbol'], 60)
            def on_bar(self, ctx, bar):
                raise ValueError('final callback error')
        def final_update(**_):
            self.api.quote.datetime = '2026-10-19 09:30:59.999999'
            self.api.frame.rows = [row(0, START, 100)]
            raise Finished()
        self.api.wait_update = final_update
        config = dict(symbol=self.api.symbol, duration=60, start=START, end=START + 60, initial_cash=10000,
            slippage_ticks=0, annualization=252, risk_free_rate=0, benchmark_symbol=None, parameters={})
        result = run(Broken(), self.api, self.api, config, output_dir=Path(self.tmp.name) / 'artifacts',
            stop_event=threading.Event(), finished_exception=Finished, sdk_version='test')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('final callback error', result['message'])
        self.assertTrue((Path(self.tmp.name) / 'dataset.json').exists())


if __name__ == '__main__':
    unittest.main()
