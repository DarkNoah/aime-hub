"""Select a single long option from contemporaneous, completed minute bars."""
from dataclasses import asdict, replace
from datetime import date, timedelta
from math import ceil, floor
import re

from .execution import Order
from .models import Instrument
from .protection import trigger
from .risk import RiskLevels, accept, publish

INDEX_OPTIONS = {'IM': 'MO', 'IF': 'IO', 'IH': 'HO'}
CASH_INDEX = {'MO': 'SSE.000852', 'IO': 'SSE.000300', 'HO': 'SSE.000016'}


def index_reference(item):
    if item.option_underlying in CASH_INDEX.values():
        return Instrument(item.option_underlying, 'stock', .01, tradable=False)
    return None


def index_chain(actual):
    match = re.fullmatch(r'CFFEX\.(IM|IF|IH)(\d{4})', actual)
    return f'CFFEX.{INDEX_OPTIONS[match[1]]}{match[2]}-' if match else None


def catalog_option(meta, source, fees, calendar):
    symbol = meta['symbol']
    match = re.fullmatch(r'CFFEX\.(?:MO|IO|HO)(\d{2})(\d{2})-([CP])-(\d+(?:\.\d+)?)', symbol)
    right = meta.get('optionRight') or (match[3] if match else None)
    strike = meta.get('strike') or (float(match[4]) if match else None)
    multiple = meta.get('volumeMultiple') or (100 if match else None)
    if right not in ('C', 'P') or not strike or not multiple:
        return None
    expiry = meta.get('expiryDay')
    if match and not expiry:
        # Legacy index-option catalogs only stored the qualified code. On an
        # unknown holiday, the third Friday bounds the verified holding period.
        first = date(2000 + int(match[1]), int(match[2]), 1)
        day = first + timedelta(days=(4 - first.weekday()) % 7 + 14)
        while calendar.days.get(day) is False:
            day += timedelta(days=1)
        expiry = day.isoformat()
    return Instrument(symbol, 'option', meta['priceTick'], multiplier=multiple, fees=fees,
                      option_underlying=CASH_INDEX[symbol[6:8]] if match else meta.get('underlying') or source, option_right=right,
                      strike=strike, expiry_day=expiry)


class OptionRouter:
    def __init__(self, context, settings):
        self.allow_unsettled_expiry = False
        self.ctx = context
        self.settings = replace(settings,
            stop_loss_pct=context.params.get('option_stop_loss_pct', settings.stop_loss_pct),
            take_profit_pct=context.params.get('option_take_profit_pct', settings.take_profit_pct))
        self.signal = context.params.get('symbol')
        if not self.signal:
            raise ValueError('option_execution requires params["symbol"]')
        # The binding survives a main-contract roll until the original option closes.
        self.state = {}
        self.known = set()
        self.by_underlying = {}
        self.by_month = {}
        for item in context.data._instruments.values():
            self.register(item)

    def register(self, item):
        if item.kind != 'option':
            return
        self.by_underlying.setdefault(item.option_underlying, set()).add(item.symbol)
        prefix = re.match(r'^CFFEX\.(?:IO|MO|HO)\d{4}-', item.symbol)
        if prefix:
            self.by_month.setdefault(prefix[0], set()).add(item.symbol)

    @property
    def broker(self):
        return self.ctx._runner.broker

    def actual(self):
        return self.ctx.data.resolve_contract(self.signal)

    def handles(self, symbol):
        if symbol == self.state.get('source'):
            return True
        if symbol != self.signal and symbol != self.ctx.data._contracts.get(self.signal):
            return False
        if self.ctx.data.instrument(self.signal).kind == 'continuous' and self.signal not in self.ctx.data._contracts:
            return False
        actual = self.actual()
        return bool(index_chain(actual) or self.signal in self.known or actual in self.known or actual in self.by_underlying)

    def position(self, symbol):
        if not self.state or symbol not in (self.signal, self.state['source'], self.ctx.data._contracts.get(self.signal)):
            return 0
        return self.state['direction'] * self.broker.position(self.state['contract'])

    def _minute(self, symbol, end=None):
        rows = self.ctx.data.history(symbol, 60, 1, as_of=end)
        if rows and self.ctx.now - rows[0].end_time < 60 and (end is None or rows[0].end_time == end):
            return rows[0]
        return None

    def _reference_at(self, symbol, time):
        """Latest signal-side observation already delivered at the simulated fill time."""
        prices = []
        for duration in dict.fromkeys((60, self.ctx.params.get('duration', 60))):
            bars = self.ctx.data.history(symbol, duration, 1, as_of=time)
            if bars:
                prices.append((bars[0].end_time, bars[0].close))
        quote = self.ctx.data.quote(symbol)
        if quote and quote.time <= time and quote.last is not None:
            prices.append((quote.time, quote.last))
        return max(prices, key=lambda p: p[0], default=None)

    def _routed_signal(self, signal_id):
        # A premium protection order belongs to its opening signal. Follow the
        # order's own provenance even if a callback has already changed the binding.
        for signal in reversed(self.ctx._runner.signals):
            if signal['id'] != signal_id:
                continue
            if signal['kind'] == 'risk_exit':
                signal_id = signal['entry_signal_id']
                continue
            if signal['kind'] == 'target_position' and signal.get('signal_symbol') == self.signal:
                return signal
            break
        return None

    def strategy_report(self, kind, report):
        """Project only routed orders into strategy coordinates. Broker records stay native."""
        contract = report['symbol']
        item = self.ctx.data.instrument(contract)
        if item.kind != 'option' or not (signal := self._routed_signal(report['signal_id'])):
            return report
        source = signal['source_contract']
        symbol = signal.get('order_symbol', self.signal)
        mapped = dict(report, symbol=symbol, signal_symbol=self.signal,
                      source_contract=source, execution_symbol=contract)
        direction = 1 if item.option_right == 'C' else -1
        if kind == 'order':
            return dict(mapped, target=direction * report['target'], execution_target=report['target'])
        price_symbol = symbol
        reference = self._reference_at(symbol, report['time'])
        if reference is None and source != symbol:
            price_symbol = source
            reference = self._reference_at(source, report['time'])
        return dict(mapped, quantity=direction * report['quantity'], execution_quantity=report['quantity'],
                    execution_price=report['price'], price_symbol=price_symbol,
                    price_time=reference[0] if reference else None, price=reference[1] if reference else None)

    def select(self, source, direction):
        choice, _ = self._select(source, direction)
        return choice

    def _select(self, source, direction):
        reference = self._minute(source)
        if not reference:
            return None, '缺少信号标的当分钟参考价'
        chain = index_chain(source)
        symbols = self.by_month.get(chain, ()) if chain else self.by_underlying.get(source, ())
        right = 'C' if direction > 0 else 'P'
        candidates = []
        spots = {source: reference}
        for symbol in symbols:
            item = self.ctx.data.instrument(symbol)
            if not item.tradable or item.option_right != right or (item.expiry_day and item.expiry_day < reference.trading_day):
                continue
            bar = self._minute(symbol, reference.end_time)
            if not bar or bar.close <= 0 or bar.day_volume is None or floor(bar.volume * self.broker.config.participation_rate) < 1:
                continue
            underlying = item.option_underlying
            if underlying not in spots:
                spots[underlying] = (self._minute(underlying, reference.end_time)
                                     if underlying in self.ctx.data._instruments else None)
            spot = spots[underlying]
            if not spot or spot.close <= 0:
                continue
            intrinsic = max(0., (spot.close - item.strike) * (1 if right == 'C' else -1))
            if intrinsic > bar.close:
                continue
            share = (bar.close - intrinsic) / bar.close
            expiry_week = bool(item.expiry_day and
                               date.fromisoformat(item.expiry_day).isocalendar()[:2] ==
                               date.fromisoformat(bar.trading_day).isocalendar()[:2])
            # Round only floating-point noise when comparing economically identical shares.
            rank = (round(abs(share - 1 / 3), 12), abs(bar.day_volume - 1000))
            decision = dict(symbol=symbol, mode=self.settings.mode, reference_symbol=underlying,
                            reference_price=spot.close, intrinsic_value=intrinsic, time_value_ratio=share,
                            premium=bar.close, volume=bar.volume, day_volume=bar.day_volume,
                            expiry_day=item.expiry_day, expiry_week=expiry_week)
            candidates.append((rank, decision))
        if not candidates:
            return None, '无同分钟有效标的价、权利金、当日累计量且可成交一手的期权'
        best_rank = min(rank for rank, _ in candidates)
        tied = [quote for rank, quote in candidates if rank == best_rank]
        in_week = [quote for quote in tied if quote['expiry_week']]
        if in_week:
            return min(in_week, key=lambda q: (abs(q['premium'] - 200), q['symbol'])), ''
        return min(tied, key=lambda q: q['symbol']), ''

    def _open(self, source, direction, reason, order_symbol=None):
        choice, skip_reason = self._select(source, direction)
        if not choice:
            signal_id = self.ctx.emit('option_entry_skipped', signal_symbol=self.signal, source_contract=source,
                                      direction=direction, reason=skip_reason, mode=self.settings.mode)
            # No broker order exists. Resolve the strategy's pending intent as
            # a rejection, without recording a virtual trade in the option account.
            order = Order(signal_id, order_symbol or self.signal, direction, self.ctx.now, signal_id,
                          status='rejected', reason=skip_reason, exit_reason=reason or 'strategy_signal')
            report = dict(asdict(order), signal_symbol=self.signal, source_contract=source,
                          execution_symbol=None, execution_target=None)
            accept(self.ctx, self.ctx._runner.strategy.on_order(self.ctx, report))
            return signal_id
        contract = choice['symbol']
        origin = {'order_symbol': order_symbol} if order_symbol and order_symbol != self.signal else {}
        binding = self.state = dict(contract=contract, source=source, direction=direction, **origin)
        signal = self.ctx.emit('target_position', **choice, target=1, signal_symbol=self.signal,
                               source_contract=source, direction=direction, reason=reason, **origin)
        binding['entry'] = signal
        order = self.broker.target_position(contract, 1, now=self.ctx.now, signal_id=signal,
                                            reason=reason, immediate_entry=True)
        binding.update(entry_order=order, entry_deadline=ceil(self.ctx.now / 60) * 60 + 60)
        return order

    def target(self, symbol, quantity, reason):
        if type(quantity) is not int:
            raise ValueError('Target position must be an integer')
        direction = (quantity > 0) - (quantity < 0)
        source = self.actual() if symbol == self.signal else symbol
        binding = self.state
        if binding:
            contract = binding['contract']
            held = self.broker.position(contract)
            pending = next((o for o in reversed(self.broker.orders)
                            if o.symbol == contract and o.status == 'pending'), None)
            if held or pending:
                if direction == binding['direction'] and (not pending or pending.target == 1):
                    return binding.get('entry_order', binding['entry'])
                if held and direction == binding['direction'] and pending and not pending.risk_entry_signal_id:
                    self.broker.cancel(pending.id)
                    binding.pop('next', None)
                    return binding['entry_order']
                if pending and pending.target == 1:
                    self.broker.cancel(pending.id)
                if held:
                    binding['next'] = (source, direction, reason, symbol) if direction else None
                    if pending and pending.target == 0:
                        return pending.id
                    exit_id = self.ctx.emit('target_position', symbol=contract, target=0,
                                            signal_symbol=self.signal, source_contract=binding['source'], reason=reason,
                                            **({'order_symbol': binding['order_symbol']} if 'order_symbol' in binding else {}))
                    return self.broker.target_position(contract, 0, now=self.ctx.now, signal_id=exit_id, reason=reason)
            self.state = {}
        if direction:
            return self._open(source, direction, reason, symbol)
        return self.ctx.emit('option_flat', source_contract=source)

    def on_bar(self, bar):
        if not self.state:
            return
        if bar.duration != 60 and bar.symbol != self.signal:
            return
        binding = self.state
        contract = binding['contract']
        held = self.broker.position(contract)
        if not held and bar.symbol == binding['source']:
            entry_id = binding.get('entry_order')
            if entry_id and bar.end_time >= binding.get('entry_deadline', float('inf')):
                entry = next((o for o in reversed(self.broker.orders) if o.id == entry_id), None)
                if entry and entry.status == 'pending':
                    self.broker.cancel(entry.id)
                    self.ctx.log('未收到可成交的期权分钟线，入场已取消', symbol=contract)
                binding.pop('entry_deadline', None)
        if held:
            expiry = self.ctx.data.instrument(contract).expiry_day
            if expiry and bar.trading_day > expiry:
                if self.allow_unsettled_expiry:
                    # Preserve the paid lot at its last observed mark until settlement
                    # data exists. New signals may bind to a current contract.
                    for order in self.broker.orders:
                        if order.symbol == contract and order.status == 'pending':
                            self.broker.cancel(order.id)
                    self.state = {}
                    return
                raise ValueError(f'{contract} 持仓跨越到期日，缺少交割结算数据')
        if held and (levels := binding.get('source_levels')) and bar.symbol == levels['symbol']:
            if levels['time'] <= bar.time and (hit := trigger(levels, binding['direction'], bar)):
                self.target(binding['source'], 0, hit[0])
                binding.pop('source_levels', None)
        reversal = binding.get('next')
        if reversal and not held and bar.symbol == reversal[0]:
            self.state = {}
            self._open(*reversal)

    def after_fill(self, fill):
        if fill['offset'] != 'open' or self.state.get('entry') != fill['signal_id']:
            return
        stop, profit = self.settings.stop_loss_pct, self.settings.take_profit_pct
        if stop is not None or profit is not None:
            price = fill['price']
            publish(self.ctx, RiskLevels(fill['symbol'], entry_id=fill['signal_id'],
                    stop_loss=price * (1 - stop / 100) if stop else None,
                    take_profit=price * (1 + profit / 100) if profit else None), active_from=fill['time'])

    def source_levels(self, levels):
        # Source-price risk stays in the signal coordinate system. A hit sends
        # a close to the bound option at its next executable price.
        if self.state:
            entry = self.state['entry']
            if levels.entry_id in (None, entry, f"{entry}:{self.state['contract']}:1"):
                self.state['source_levels'] = {**asdict(levels), 'time': self.ctx.now}
