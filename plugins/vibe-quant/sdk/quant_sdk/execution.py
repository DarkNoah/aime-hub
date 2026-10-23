"""A deterministic paper broker. No exchange/broker credentials or real orders."""
from dataclasses import asdict, dataclass
from math import ceil, floor
from typing import Callable

from .data import DataView
from .models import Bar, Instrument, RunConfig
from .protection import ProtectionBook, trigger


@dataclass
class Lot:
    symbol: str
    quantity: int
    entry_price: float
    basis: float
    entry_time: float
    trading_day: str
    entry_fee: float
    signal_id: str


@dataclass
class Order:
    id: str
    symbol: str
    target: int
    submitted_at: float
    signal_id: str
    status: str = 'pending'
    reason: str = ''
    exit_reason: str = 'strategy_signal'
    risk_entry_signal_id: str | None = None
    risk_level_id: str | None = None
    trigger_price: float | None = None
    trigger_time: float | None = None
    trigger_bar_time: float | None = None
    trigger_time_precision: str | None = None


class PaperBroker:
    def __init__(self, data: DataView, config: RunConfig, notify: Callable, risk_signal: Callable):
        self.data, self.config, self.notify = data, config, notify
        self.cash = config.initial_cash
        self.lots: list[Lot] = []
        self.orders: list[Order] = []
        self.fills: list[dict] = []
        self.trades: list[dict] = []
        self.marks: dict[str, float] = {}
        self.trading_day = ''
        self.protection = ProtectionBook()
        self.risk_signal = risk_signal

    def position(self, symbol: str) -> int:
        return sum(lot.quantity for lot in self.lots if lot.symbol == symbol)

    def account(self) -> dict:
        stock_value = unrealized = margin = 0.0
        for lot in self.lots:
            item = self.data.instrument(lot.symbol)
            price = self.marks.get(lot.symbol, lot.basis)
            if item.kind == 'stock':
                stock_value += price * lot.quantity * item.multiplier
            else:
                unrealized += (price - lot.basis) * lot.quantity * item.multiplier
                margin += abs(price * lot.quantity * item.multiplier) * item.margin_rate
        return {'cash': self.cash, 'equity': self.cash + stock_value + unrealized,
                'margin': margin, 'available': self.cash + unrealized - margin,
                'positions': {symbol: self.position(symbol) for symbol in sorted({lot.symbol for lot in self.lots})}}

    def begin_day(self, day: str) -> None:
        if self.trading_day and day < self.trading_day:
            raise ValueError('Trading days must not move backwards')
        if self.trading_day and day != self.trading_day:
            # Close-mark settlement proxy; the model is recorded in run metadata.
            for lot in self.lots:
                item = self.data.instrument(lot.symbol)
                if item.kind == 'future':
                    price = self.marks.get(lot.symbol, lot.basis)
                    self.cash += (price - lot.basis) * lot.quantity * item.multiplier
                    lot.basis = price
        self.trading_day = day

    def validate_target(self, symbol: str, target: int) -> None:
        item = self.data.instrument(symbol)
        if not isinstance(target, int) or isinstance(target, bool):
            raise ValueError('Target position must be an integer')
        if not item.tradable or item.kind == 'continuous':
            raise ValueError('Orders require a tradable, actual instrument')
        if item.kind == 'stock' and target < 0:
            raise ValueError('Uncovered stock short selling is unsupported')

    def target_position(self, symbol: str, target: int, *, now: float, signal_id: str, reason: str = '') -> str:
        self.validate_target(symbol, target)
        order_id = f'{signal_id}:{symbol}:{target}'
        if any(order.id == order_id for order in self.orders):
            return order_id
        for pending in self.orders:
            if pending.symbol == symbol and pending.status == 'pending' and not pending.risk_entry_signal_id:
                self._status(pending, 'cancelled', 'replaced')
        order = Order(order_id, symbol, target, now, signal_id, exit_reason=reason or 'strategy_signal')
        self.orders.append(order)
        if any(o.symbol == symbol and o.status == 'pending' and o.risk_entry_signal_id
               and any(lot.signal_id == o.risk_entry_signal_id for lot in self.lots) for o in self.orders):
            self._status(order, 'rejected', 'RISK_EXIT_PENDING')
        elif target == self.position(symbol):
            self._status(order, 'filled', 'already_at_target')
        else:
            self.notify('order', asdict(order))
        return order_id

    def cancel(self, order_id: str) -> None:
        for order in self.orders:
            if order.id == order_id and order.status == 'pending':
                self._status(order, 'cancelled', 'user_cancelled')

    def cancel_all(self, reason: str) -> None:
        for order in self.orders:
            if order.status == 'pending':
                self._status(order, 'cancelled', reason)

    def _status(self, order: Order, status: str, reason: str = '') -> None:
        order.status, order.reason = status, reason
        self.notify('order', asdict(order))

    @staticmethod
    def _fee(item: Instrument, quantity: int, price: float, *, closing_today: bool = False) -> float:
        fee = item.fees
        per_unit = fee.close_today_per_unit if closing_today and fee.close_today_per_unit is not None else fee.per_unit
        rate = fee.close_today_rate if closing_today and fee.close_today_rate is not None else fee.rate
        notional = abs(quantity * price * item.multiplier)
        return max(fee.minimum, abs(quantity) * per_unit + notional * rate) + (notional * fee.sell_tax_rate if quantity < 0 else 0)

    def on_bar(self, bar: Bar) -> None:
        item = self.data.instrument(bar.symbol)
        if not bar.is_final or not item.tradable or bar.duration != self.config.execution_duration:
            return
        # Every order for this instrument shares the same bar-volume budget.
        budget = floor(bar.volume * self.config.participation_rate)
        entries = {lot.signal_id for lot in self.lots if lot.symbol == bar.symbol}
        entries.update(o.signal_id for o in self.orders if o.symbol == bar.symbol and o.status == 'pending')
        levels = self.protection.at_open(bar.time, entries)
        # Already-triggered remainder is a market close; a later level update
        # cannot cancel a risk exit that is waiting on volume or T+1.
        for order in list(self.orders):
            if (order.symbol == bar.symbol and order.risk_entry_signal_id and order.status == 'pending'
                    and order.submitted_at <= bar.time):
                budget = self._protective_fill(order, bar, budget, bar.open, bar.time, 'open')
        budget = self._risk_exits(bar, levels, budget, open_only=True)
        for order in list(self.orders):
            if (order.symbol != bar.symbol or order.status != 'pending' or bar.time < order.submitted_at
                    or order.risk_entry_signal_id):
                continue
            if budget <= 0:
                continue
            delta = order.target - self.position(bar.symbol)
            if not delta:
                self._status(order, 'filled')
                continue
            direction = 1 if delta > 0 else -1
            price = bar.open + direction * self.config.slippage_ticks * item.price_tick
            price = (ceil(price / item.price_tick - 1e-8) if direction > 0
                     else floor(price / item.price_tick + 1e-8)) * item.price_tick
            if price <= 0 or not bar.low <= price <= bar.high:
                continue
            remaining = min(abs(delta), budget)
            # Close FIFO first. A target reversal becomes a close and then an open.
            for lot in list(self.lots):
                if remaining == 0:
                    break
                if lot.symbol != bar.symbol or lot.quantity * direction >= 0:
                    continue
                if item.t_plus_one and lot.trading_day == bar.trading_day:
                    self._status(order, 'rejected', 'T_PLUS_ONE')
                    break
                size = min(abs(lot.quantity), remaining)
                self._close_lot(order, lot, size, price, bar, bar.time, 'open')
                remaining -= size
                budget -= size
            if order.status != 'pending':
                continue
            if remaining:
                size = remaining // item.lot_size * item.lot_size
                if size == 0:
                    if abs(order.target - self.position(bar.symbol)) < item.lot_size:
                        self._status(order, 'rejected', 'LOT_SIZE')
                    continue
                signed = direction * size
                fee = self._fee(item, signed, price)
                required = price * size * item.multiplier * (item.margin_rate if item.kind == 'future' else 1)
                # Marks for margin must reflect the execution price, not a stale prior close.
                self.marks[bar.symbol] = price
                if self.account()['available'] + 1e-8 < required + fee:
                    self._status(order, 'rejected', 'INSUFFICIENT_FUNDS')
                    continue
                self.cash -= fee + (price * signed * item.multiplier if item.kind == 'stock' else 0)
                self.lots.append(Lot(bar.symbol, signed, price, price, bar.time, bar.trading_day, fee, order.signal_id))
                budget -= size
                self._fill(order, signed, price, fee, bar, 'open')
            if self.position(bar.symbol) == order.target:
                self._status(order, 'filled')
        self._risk_exits(bar, levels, budget, open_only=False)
        self.marks[bar.symbol] = bar.close

    def _risk_exits(self, bar: Bar, levels: dict, budget: int, *, open_only: bool) -> int:
        for entry in dict.fromkeys(lot.signal_id for lot in self.lots if lot.symbol == bar.symbol):
            record = levels.get(entry)
            if record is None or any(o.risk_entry_signal_id == entry for o in self.orders):
                continue
            quantity = sum(lot.quantity for lot in self.lots if lot.signal_id == entry)
            hit = trigger(record, 1 if quantity > 0 else -1, bar, open_only=open_only)
            if hit is None:
                continue
            reason, threshold, base, time, precision = hit
            signal_id = self.risk_signal(symbol=bar.symbol, entry_signal_id=entry,
                                         risk_level_id=record['id'], reason=reason, trigger_price=threshold,
                                         trigger_time=time, trigger_bar_time=bar.time,
                                         trigger_time_precision=precision)
            # Cancel an unfilled entry/reversal remainder before protective exit.
            for pending in list(self.orders):
                if pending.symbol == bar.symbol and pending.status == 'pending' and not pending.risk_entry_signal_id:
                    self._status(pending, 'cancelled', 'risk_exit_triggered')
            order = Order(f'risk:{record["id"]}', bar.symbol, self.position(bar.symbol) - quantity,
                          self.data.now, signal_id, exit_reason=reason, risk_entry_signal_id=entry,
                          risk_level_id=record['id'], trigger_price=threshold, trigger_time=time,
                          trigger_bar_time=bar.time, trigger_time_precision=precision)
            self.orders.append(order)
            self.notify('order', asdict(order))
            budget = self._protective_fill(order, bar, budget, base, time, precision)
        return budget

    def _protective_fill(self, order: Order, bar: Bar, budget: int, base: float, time: float, precision: str) -> int:
        item = self.data.instrument(bar.symbol)
        for lot in list(self.lots):
            if lot.signal_id != order.risk_entry_signal_id:
                continue
            if item.t_plus_one and lot.trading_day == bar.trading_day:
                if order.reason != 'T_PLUS_ONE':
                    self._status(order, 'pending', 'T_PLUS_ONE')
                continue
            if budget <= 0:
                if order.reason != 'VOLUME_LIMIT':
                    self._status(order, 'pending', 'VOLUME_LIMIT')
                break
            direction = -1 if lot.quantity > 0 else 1
            raw = base + direction * self.config.slippage_ticks * item.price_tick
            price = (ceil(raw / item.price_tick - 1e-8) if direction > 0
                     else floor(raw / item.price_tick + 1e-8)) * item.price_tick
            # Slippage is an adverse execution cost and may extend past OHLC;
            # never silently discard a triggered exit merely for that reason.
            price = max(item.price_tick, price)
            size = min(abs(lot.quantity), budget)
            self._close_lot(order, lot, size, price, bar, time, precision)
            budget -= size
        if not any(lot.signal_id == order.risk_entry_signal_id for lot in self.lots):
            self._status(order, 'filled')
        return budget

    def _close_lot(self, order: Order, lot: Lot, size: int, price: float, bar: Bar, time: float, precision: str):
        item = self.data.instrument(bar.symbol)
        side = 1 if lot.quantity > 0 else -1
        signed = -side * size
        fee = self._fee(item, signed, price, closing_today=lot.trading_day == bar.trading_day)
        entry_fee = lot.entry_fee * size / abs(lot.quantity)
        gross = (price - lot.entry_price) * side * size * item.multiplier
        if item.kind == 'stock':
            self.cash -= signed * price * item.multiplier + fee
        else:
            self.cash += (price - lot.basis) * side * size * item.multiplier - fee
        exit_details = {'exit_reason': order.exit_reason, 'exit_bar_time': bar.time,
                        'exit_time_precision': precision, 'risk_level_id': order.risk_level_id,
                        'trigger_price': order.trigger_price, 'trigger_time': order.trigger_time,
                        'trigger_bar_time': order.trigger_bar_time,
                        'trigger_time_precision': order.trigger_time_precision}
        self.trades.append({'id': f'trade-{len(self.trades) + 1}', 'symbol': bar.symbol,
                            'side': 'long' if side > 0 else 'short', 'quantity': size,
                            'entry_time': lot.entry_time, 'exit_time': time,
                            'entry_price': lot.entry_price, 'exit_price': price,
                            'gross_pnl': gross, 'fees': entry_fee + fee, 'net_pnl': gross - entry_fee - fee,
                            'entry_signal_id': lot.signal_id, 'exit_signal_id': order.signal_id, **exit_details})
        lot.entry_fee -= entry_fee
        lot.quantity += signed
        if lot.quantity == 0:
            self.lots.remove(lot)
        self._fill(order, signed, price, fee, bar, 'close', time=time, details=exit_details)

    def _fill(self, order: Order, quantity: int, price: float, fee: float, bar: Bar, offset: str,
              *, time: float | None = None, details: dict | None = None) -> None:
        fill = {'id': f'fill-{len(self.fills) + 1}', 'order_id': order.id, 'signal_id': order.signal_id,
                'symbol': order.symbol, 'time': bar.time if time is None else time, 'trading_day': bar.trading_day,
                'quantity': quantity, 'price': price, 'fee': fee, 'offset': offset, **(details or {})}
        self.fills.append(fill)
        self.notify('fill', fill)
