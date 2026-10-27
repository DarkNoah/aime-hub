"""TqSim execution adapter. TqSim alone decides fills, cash, margin and positions.

The local FIFO ledger only attributes native fills to strategy signals for reports.
No PaperBroker matching or account arithmetic is used here.
"""
from hashlib import sha256
from dataclasses import asdict, dataclass, field
from datetime import datetime
from math import ceil, floor, isfinite

from .execution import Lot, Order
from .protection import ProtectionBook


@dataclass
class TargetOrder(Order):
    native_orders: list[dict] = field(default_factory=list)


class TqBroker:
    points = False

    def __init__(self, runner, api, sim, quote, calendar):
        self.runner, self.api, self.sim = runner, api, sim
        self.quote, self.calendar = quote, calendar
        self.data, self.config = runner.data, runner.config
        self.symbol = next(iter(self.data._instruments))
        self.native_position = api.get_position(self.symbol)
        self.native_account = api.get_account()
        self.orders, self.fills, self.trades, self.lots = [], [], [], []
        self.protection = ProtectionBook()
        self.marks, self.trading_day = {}, ''
        self.fill_sequence = self.trade_sequence = 0
        self.children = {}  # active native id -> (entity, parent)
        self.seen_trades = set()
        self.stopping = False

    @property
    def cash(self):
        return self.account()['cash']

    def account(self):
        value = self.native_account
        return {'cash': float(value.balance - value.float_profit), 'equity': float(value.balance),
                'margin': float(value.margin), 'available': float(value.available),
                'positions': {self.symbol: self.position(self.symbol)},
                'frozen_margin': float(value.frozen_margin), 'source': 'TqSim'}

    def position(self, symbol):
        self.data.instrument(symbol)
        return int(self.native_position.pos_long - self.native_position.pos_short)

    def begin_day(self, day):
        # Native settlement is already reflected in get_account/get_position.
        self.trading_day = day

    def on_bar(self, bar):
        self.marks[bar.symbol] = bar.close

    def validate_target(self, symbol, quantity):
        if symbol != self.symbol or self.data.instrument(symbol).kind != 'future':
            raise ValueError('天勤回测仅允许交易所选期货实际合约')
        if type(quantity) is not int:
            raise ValueError('期货目标持仓必须为整数手数')

    def _status(self, order, status, reason=''):
        if order.status == status and order.reason == reason:
            return
        order.status, order.reason = status, reason
        self.runner._notify('order', asdict(order))

    def target_position(self, symbol, target, *, now, signal_id, reason=''):
        self.validate_target(symbol, target)
        order_id = f'{signal_id}:{symbol}:{target}'
        if any(order.id == order_id for order in self.orders):
            return order_id
        for order in list(self.orders):
            if order.status == 'pending' and not order.risk_entry_signal_id:
                self.cancel(order.id, 'replaced')
        order = TargetOrder(order_id, symbol, target, now, signal_id, exit_reason=reason or 'strategy_signal')
        self.orders.append(order)
        if self.stopping:
            self._status(order, 'cancelled', 'run_finished')
        elif any(o.status == 'pending' and o.risk_entry_signal_id for o in self.orders):
            self._status(order, 'rejected', 'RISK_EXIT_PENDING')
        else:
            self.runner._notify('order', asdict(order))
        return order_id

    def cancel(self, order_id, reason='user_cancelled'):
        for order in self.orders:
            if order.id != order_id or order.status != 'pending':
                continue
            for native, parent in self.children.values():
                if parent is order and native.status != 'FINISHED':
                    self.api.cancel_order(native)
            self._status(order, 'cancelled', reason)

    def cancel_all(self, reason):
        self.stopping = True
        for order in list(self.orders):
            self.cancel(order.id, reason)

    def sync(self):
        """Consume every native fill exactly once, including a fill racing cancellation."""
        for native, parent in list(self.children.values()):
            for trade_id, trade in sorted(native.trade_records.items(), key=lambda item: item[1].trade_date_time):
                key = (native.order_id, trade_id)
                if key in self.seen_trades:
                    continue
                self.seen_trades.add(key)
                self._fill(parent, trade)
            details = next(row for row in parent.native_orders if row['id'] == native.order_id)
            details.update(status=native.status, remaining=int(native.volume_left), message=native.last_msg)
            if native.status == 'FINISHED' and native.volume_left and parent.status == 'pending':
                self._status(parent, 'rejected', native.last_msg or 'TqSim 委托未成交')
            if native.status == 'FINISHED' and sum(t.volume for t in native.trade_records.values()) == native.volume_orign - native.volume_left:
                del self.children[native.order_id]
        # All trade callbacks see native account state from this same SDK update.
        for parent in list(self.orders):
            if parent.status != 'pending' or self._active(parent):
                continue
            done = (not any(l.signal_id == parent.risk_entry_signal_id for l in self.lots)
                    if parent.risk_entry_signal_id else self.position(self.symbol) == parent.target)
            if done:
                self._status(parent, 'filled')

    def _active(self, parent=None):
        # FINISHED may arrive before the last fill; sync removes the child only
        # after all expected fills have been attributed.
        return any(parent is None or owner is parent for _, owner in self.children.values())

    def advance(self):
        """Serialize closes before opens; wait for cancellation acknowledgement before replacing."""
        if self.stopping or self._active():
            return
        sessions = self.quote.get('trading_time')
        if sessions:
            local = datetime.fromisoformat(self.quote.datetime)
            seconds = local.hour * 3600 + local.minute * 60 + local.second + local.microsecond / 1e6
            def session_seconds(value):
                parts = [int(part) for part in value.split(':')]
                return parts[0] * 3600 + parts[1] * 60 + (parts[2] if len(parts) > 2 else 0)
            windows = [(session_seconds(start), session_seconds(end))
                       for start, end in [*sessions.get('day', []), *sessions.get('night', [])]]
            if not any(start <= seconds < end or start <= seconds + 86400 < end
                       for start, end in windows):
                return  # Daily-bar signals wait for the next tradable quote.
        pending = [o for o in self.orders if o.status == 'pending']
        if not pending:
            return
        parent = next((o for o in pending if o.risk_entry_signal_id), pending[0])
        position = self.position(self.symbol)
        protected = [l for l in self.lots if l.signal_id == parent.risk_entry_signal_id]
        delta = -sum(l.quantity for l in protected) if parent.risk_entry_signal_id else parent.target - position
        if not delta:
            self._status(parent, 'filled')
            return
        direction = 'BUY' if delta > 0 else 'SELL'
        offset, size = 'OPEN', abs(delta)
        if position * delta < 0:
            side = 'long' if position > 0 else 'short'
            his = int(getattr(self.native_position, f'pos_{side}_his'))
            today = int(getattr(self.native_position, f'pos_{side}_today'))
            size = min(size, abs(position))
            if self.symbol.startswith(('SHFE.', 'INE.')):
                # A targeted protective exit must close the entry's trading-date bucket.
                if protected:
                    is_today = protected[0].trading_day == self.runner.context.trading_day
                    offset = 'CLOSETODAY' if is_today else 'CLOSE'
                    size = min(size, today if is_today else his,
                               sum(abs(l.quantity) for l in protected
                                   if (l.trading_day == self.runner.context.trading_day) == is_today))
                else:
                    offset, size = ('CLOSE', min(size, his)) if his else ('CLOSETODAY', min(size, today))
            else:
                offset = 'CLOSE'
        if size <= 0:
            raise ValueError('TqSim 持仓与成交台账不一致')
        maximum = self.quote.max_limit_order_volume
        if isfinite(maximum) and maximum > 0:
            size = min(size, int(maximum))
        price = self.quote.ask_price1 if delta > 0 else self.quote.bid_price1
        if not isfinite(price) or price <= 0:
            return  # No opposite quote: keep the target pending, do not invent a fill.
        tick = self.quote.price_tick
        price += (1 if delta > 0 else -1) * self.config.slippage_ticks * tick
        price = (ceil(price / tick - 1e-8) if delta > 0 else floor(price / tick + 1e-8)) * tick
        for bound, upper in ((self.quote.upper_limit, True), (self.quote.lower_limit, False)):
            if isfinite(bound) and bound > 0:
                price = min(price, bound) if upper else max(price, bound)
        native_id = sha256(f'{parent.id}:{len(parent.native_orders)}'.encode()).hexdigest()[:32]
        native = self.api.insert_order(self.symbol, direction=direction, offset=offset, volume=size, limit_price=price, order_id=native_id)
        self.children[native.order_id] = (native, parent)
        parent.native_orders.append({'id': native.order_id, 'direction': direction, 'offset': offset,
                                     'quantity': size, 'limit_price': price, 'status': 'ALIVE',
                                     'remaining': size, 'message': ''})

    def check_risk(self):
        """Protection observes replay quotes, never retroactively trades at a candle's high/low."""
        now, price = self.data.now, self.quote.last_price
        if not isfinite(price):
            return
        for entry in dict.fromkeys(l.signal_id for l in self.lots):
            if any(o.risk_entry_signal_id == entry and o.status in ('pending', 'filled') for o in self.orders):
                continue
            levels = self.protection.at_open(now, {entry}).get(entry)
            if not levels:
                continue
            quantity = sum(l.quantity for l in self.lots if l.signal_id == entry)
            stop, profit = levels['stop_loss'], levels['take_profit']
            reason = ('stop_loss' if stop is not None and (price <= stop if quantity > 0 else price >= stop)
                      else 'take_profit' if profit is not None and (price >= profit if quantity > 0 else price <= profit)
                      else None)
            if not reason:
                continue
            for order in list(self.orders):
                if order.status == 'pending' and not order.risk_entry_signal_id:
                    self.cancel(order.id, 'risk_exit_triggered')
            threshold = stop if reason == 'stop_loss' else profit
            signal_id = self.runner.context.emit('risk_exit', symbol=self.symbol, entry_signal_id=entry,
                risk_level_id=levels['id'], reason=reason, trigger_price=threshold, trigger_time=now,
                trigger_bar_time=floor(now / 60) * 60, trigger_time_precision='quote')
            parent = TargetOrder(f'risk:{levels["id"]}:{len(self.orders)}', self.symbol,
                self.position(self.symbol) - quantity, now, signal_id, exit_reason=reason,
                risk_entry_signal_id=entry, risk_level_id=levels['id'], trigger_price=threshold,
                trigger_time=now, trigger_bar_time=floor(now / 60) * 60, trigger_time_precision='quote')
            self.orders.append(parent)
            self.runner._notify('order', asdict(parent))

    def _fill(self, parent, trade):
        time = trade.trade_date_time / 1e9
        day = self.calendar.trading_day(time, futures=True)
        quantity = int(trade.volume) * (1 if trade.direction == 'BUY' else -1)
        price = float(trade.price)
        fee = float(trade.get('commission', abs(quantity) * self.sim.get_commission(self.symbol)))
        if not all(isfinite(v) for v in (time, price, fee)) or fee < 0:
            raise ValueError('TqSim 返回无效成交或费用')
        details = {'exit_reason': parent.exit_reason, 'exit_bar_time': floor(time / 60) * 60,
                   'exit_time_precision': 'quote', 'risk_level_id': parent.risk_level_id,
                   'trigger_price': parent.trigger_price, 'trigger_time': parent.trigger_time,
                   'trigger_bar_time': parent.trigger_bar_time, 'trigger_time_precision': parent.trigger_time_precision}
        if trade.offset == 'OPEN':
            self.lots.append(Lot(self.symbol, quantity, price, price, time, day, fee, parent.signal_id))
        else:
            remaining = abs(quantity)
            candidates = [l for l in self.lots if l.quantity * quantity < 0]
            if self.symbol.startswith(('SHFE.', 'INE.')):
                candidates = [l for l in candidates if (l.trading_day == day) == (trade.offset == 'CLOSETODAY')]
            if parent.risk_entry_signal_id:
                candidates.sort(key=lambda l: l.signal_id != parent.risk_entry_signal_id)
            else:
                candidates.sort(key=lambda l: l.trading_day == day)
            for lot in candidates:
                if not remaining:
                    break
                size = min(remaining, abs(lot.quantity))
                entry_fee, close_fee = lot.entry_fee * size / abs(lot.quantity), fee * size / abs(quantity)
                gross = (price - lot.entry_price) * (1 if lot.quantity > 0 else -1) * size * self.quote.volume_multiple
                self.trade_sequence += 1
                self.trades.append({'id': f'trade-{self.trade_sequence}', 'symbol': self.symbol,
                    'side': 'long' if lot.quantity > 0 else 'short', 'quantity': size,
                    'entry_time': lot.entry_time, 'exit_time': time, 'entry_price': lot.entry_price,
                    'exit_price': price, 'gross_pnl': gross, 'fees': entry_fee + close_fee,
                    'net_pnl': gross - entry_fee - close_fee, 'entry_signal_id': lot.signal_id,
                    'exit_signal_id': parent.signal_id, **details})
                lot.entry_fee -= entry_fee
                lot.quantity += size if quantity > 0 else -size
                remaining -= size
                if not lot.quantity:
                    self.lots.remove(lot)
            if remaining:
                raise ValueError('TqSim 平仓成交缺少对应开仓台账')
        self.fill_sequence += 1
        fill = {'id': f'fill-{self.fill_sequence}', 'order_id': parent.id, 'signal_id': parent.signal_id,
                'native_order_id': trade.order_id, 'native_trade_id': trade.trade_id,
                'symbol': self.symbol, 'time': time, 'trading_day': day, 'quantity': quantity,
                'price': price, 'fee': fee, 'offset': 'open' if trade.offset == 'OPEN' else 'close',
                **(details if trade.offset != 'OPEN' else {})}
        self.fills.append(fill)
        self.runner._notify('fill', fill)
