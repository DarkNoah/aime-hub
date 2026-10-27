"""Native monitor outbox: persist the account checkpoint before publishing its records."""
from dataclasses import asdict
from time import monotonic
from quant_sdk.tq_metrics import performance
from quant_sdk.tq_restore import snapshot_runner
from strategy_monitor import SignalOutput


class NativeSignalOutput(SignalOutput):
    """Transaction signals reflect native fills, not merely submitted targets."""
    def __call__(self, event):
        if event["type"] == "signal":
            return
        if event["type"] != "fill":
            return super().__call__(event)
        value = event["payload"]
        opened = value["offset"] == "open"
        side = "long" if (value["quantity"] > 0) == opened else "short"
        record = {"id": "native:" + value["native_trade_id"], "type": "entry" if opened else "exit",
            "side": side, "symbol": value["symbol"], "time": value["time"],
            "chart_time": int(value["time"] // 60) * 60, "price": value["price"],
            "reason": value.get("exit_reason") or "strategy_signal"}
        self.targets[value["symbol"]] = self.runner.broker.position(value["symbol"])
        self.dirty = True
        self.history.signal(record)
        if value["time"] > self.cutoff:
            self.client.call("signal", signal=record)



class NativeHistory:
    def __init__(self, client, config, saved=None):
        self.client, self.config = client, config
        self.pending, self.notifications = [], []
        self.overlay = None
        self.runner = self.feed = self.sim = self.api = self.output = None
        self.last_commit = monotonic()
        self.phase = (saved or {}).get('phase', 'history')
        self.state = (saved or {}).get('history', {'daily': {}, 'risk_levels': {}})
        self.sequence = 0

    def signal(self, value):
        self.pending.append({'kind': 'signal', 'id': value['id'], 'time': value['time'], 'payload': value})

    def call(self, kind, **value):
        # SignalOutput retains existing visual signal semantics, but notification
        # delivery waits until the same account/strategy checkpoint is durable.
        if kind == 'signal':
            self.notifications.append(value['signal'])
        elif kind == 'overlay':
            self.overlay = value['overlay']
        else:
            return self.client.call(kind, **value)
        return True

    def observe(self, runner, feed, sequence):
        self.sequence, self.feed = sequence, feed
        for point in runner.curve:
            self.state['daily'][point['trading_day']] = point
        runner.curve.clear()
        risks = self.state['risk_levels']
        for record in runner.risk_levels:
            risks[record['id']] = dict(record)
        for trade in runner.broker.trades:
            levels = [value for value in risks.values() if value['entry_signal_id'] == trade['entry_signal_id']]
            self.pending.append({'kind': 'trade', 'id': trade['id'], 'time': trade['exit_time'],
                                 'payload': {**trade, 'risk_levels': levels}})
        for fill in runner.broker.fills:
            self.pending.append({'kind': 'fill', 'id': fill['id'], 'time': fill['time'], 'payload': fill})
        for order in runner.broker.orders:
            if order.status == 'pending' or getattr(self, 'written_orders', {}).get(order.id) != order.status:
                self.pending.append({'kind': 'order', 'id': order.id, 'time': runner.data.now, 'payload': asdict(order)})
        # Coalesce order transitions by identity within each transactional outbox.
        runner.broker.trades.clear()
        runner.broker.fills.clear()
        self.output.flush_overlay(self.config['symbol'])
        if monotonic() - self.last_commit >= 2 or len(self.pending) >= 500:
            self.commit()
        self.compact()

    def compact(self):
        runner = self.runner
        active = {lot.signal_id for lot in runner.broker.lots}
        active.update(order.signal_id for order in runner.broker.orders if order.status == 'pending')
        active.update(parent.signal_id for _, parent in runner.broker.children.values())
        active.update(parent.risk_entry_signal_id for _, parent in runner.broker.children.values())
        runner.signals[:] = [v for v in runner.signals[:-200] if v['id'] in active] + runner.signals[-200:]
        runner.signal_ids = {v['id'] for v in runner.signals}
        retained = active | runner.signal_ids
        runner.broker.orders[:] = [o for o in runner.broker.orders if o.status == 'pending' or o.signal_id in retained]
        self.written_orders = {o.id: o.status for o in runner.broker.orders}
        self.state['risk_levels'] = {key: value for key, value in self.state['risk_levels'].items() if value['entry_signal_id'] in active}
        latest = {}
        for value in runner.risk_levels:
            if value['entry_signal_id'] in active:
                latest[(value['symbol'], value['entry_signal_id'])] = value
        runner.risk_levels[:] = list(latest.values())
        runner.broker.protection.history = {}
        for value in runner.risk_levels:
            runner.broker.protection.update(value)
        runner.logs[:] = runner.logs[-100:]
        # Completed native identities are already absent from children and cannot
        # be emitted again by sync; only active children need fill deduplication.
        runner.broker.seen_trades = {key for key in runner.broker.seen_trades if key[0] in runner.broker.children}

    def summary(self):
        runner = self.runner
        opened = []
        for index, lot in enumerate(runner.broker.lots):
            opened.append({'id': f'open:{lot.signal_id}:{lot.entry_time}:{index}', 'status': 'open',
                'symbol': lot.symbol, 'side': 'long' if lot.quantity > 0 else 'short', 'quantity': abs(lot.quantity),
                'entry_time': lot.entry_time, 'entry_price': lot.entry_price, 'entry_signal_id': lot.signal_id,
                'fees': lot.entry_fee, 'exit_time': None, 'exit_price': None, 'gross_pnl': None, 'net_pnl': None,
                'exit_signal_id': None, 'observed_until': runner.data.now,
                'risk_levels': [v for v in self.state['risk_levels'].values() if v['entry_signal_id'] == lot.signal_id]})
        return {**performance(self.sim, runner.broker.quote), 'start': self.config['history_start'],
            'through': runner.data.now, 'initial_cash': self.config['initial_cash'], 'replaying': self.phase == 'history',
            'equity_curve': [v for _, v in sorted(self.state['daily'].items())], 'open_trades': opened,
            'pnl_unit': 'currency', 'execution_model': 'actual_contract', 'account': runner.broker.account()}

    def checkpoint(self, outbox):
        return {'native_schema': 1, 'phase': self.phase, 'config': self.config,
            'native': self.sim.snapshot(self.api), 'context': snapshot_runner(self.runner, self.sequence),
            'targets': self.output.targets, 'risk_times': self.output.risk_times, 'history': self.state,
            'outbox': outbox}

    def commit(self):
        records = list({(record['kind'], record['id']): record for record in self.pending}.values())
        outbox = {'batch': {'records': records, 'summary': self.summary()},
                  'overlay': self.overlay, 'signals': self.notifications}
        self.client.call('commit', checkpoint=self.checkpoint(outbox))
        self.pending, self.notifications, self.overlay = [], [], None
        self.last_commit = monotonic()
