"""Select a single long option from contemporaneous, completed minute bars."""
from collections import defaultdict
from dataclasses import asdict, dataclass, replace
from datetime import date, timedelta
from math import ceil, erfc, floor, log, sqrt
from statistics import median
import re

from .models import Bar, Instrument, OPTION_PROFILE_CATALOG
from .protection import trigger
from .risk import RiskLevels, publish

INDEX_OPTIONS = {'IM': 'MO', 'IF': 'IO', 'IH': 'HO'}


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
                      option_underlying=meta.get('underlying') or source, option_right=right,
                      strike=strike, expiry_day=expiry)


def _black_metrics(reference, premium, strike, right):
    """Invert the zero-rate Black price for sigma*sqrt(T), then compute forward delta."""
    sign = 1 if right == 'C' else -1
    if reference <= 0 or not max(0, sign * (reference - strike)) < premium < (reference if sign == 1 else strike):
        return None
    log_fk = log(reference / strike)
    def cdf(x):
        return erfc(-x / sqrt(2)) / 2

    low, high = 0., 32.
    for _ in range(48):
        deviation = (low + high) / 2
        d1 = log_fk / deviation + deviation / 2
        price = sign * (reference * cdf(sign * d1) - strike * cdf(sign * (d1 - deviation)))
        if price < premium:
            low = deviation
        else:
            high = deviation
    deviation = (low + high) / 2
    delta = sign * cdf(sign * (log_fk / deviation + deviation / 2))
    return abs(delta) * reference / premium, delta, deviation


def effective_leverage(reference, premium, strike, right):
    metrics = _black_metrics(reference, premium, strike, right)
    return metrics[:2] if metrics else None


@dataclass(frozen=True)
class _Candidate:
    item: Instrument
    bar: Bar
    leverage: float
    delta: float
    deviation: float  # implied volatility times sqrt(years to expiry)


def _screen_profile(quotes, settings):
    preset = OPTION_PROFILE_CATALOG['profiles'][settings.profile]
    iv_cap = OPTION_PROFILE_CATALOG['iv_limits'][settings.iv_preference]
    # Each liquid strike gets one vote, including strikes outside the desired Delta band.
    by_expiry = defaultdict(lambda: defaultdict(list))
    for quote in quotes:
        if quote.item.expiry_day:
            by_expiry[quote.item.expiry_day][quote.item.strike].append(quote.deviation)
    references = {expiry: (median(median(values) for values in strikes.values()), len(strikes))
                  for expiry, strikes in by_expiry.items() if len(strikes) >= 3}
    in_band = [q for q in quotes if preset['delta_min'] <= abs(q.delta) <= preset['delta_max']]
    if not in_band:
        return [], {}, '没有符合该风格 Delta 范围的合约'
    comparable = [q for q in in_band if q.item.expiry_day in references]
    if not comparable:
        return [], {}, '缺少到期日或同到期同方向至少三个有效行权价，无法比较 IV'
    # At one time and expiry sqrt(T) cancels, so this is the annualized IV ratio too.
    passing = [q for q in comparable if q.deviation / references[q.item.expiry_day][0] <= iv_cap + 1e-10]
    return passing, references, '符合 Delta 的合约均超过所选 IV 上限' if not passing else ''


class OptionRouter:
    def __init__(self, context, settings):
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
        quotes = []
        for symbol in symbols:
            item = self.ctx.data.instrument(symbol)
            if not item.tradable or item.option_right != right or (item.expiry_day and item.expiry_day < reference.trading_day):
                continue
            bar = self._minute(symbol, reference.end_time)
            if not bar or floor(bar.volume * self.broker.config.participation_rate) < 1:
                continue
            metrics = _black_metrics(reference.close, bar.close, item.strike, right)
            if metrics:
                quotes.append(_Candidate(item, bar, *metrics))
        if not quotes:
            return None, '无当分钟有效价格、Delta 或足够成交量的期权'
        if self.settings.profile:
            quotes, references, reason = _screen_profile(quotes, self.settings)
            if not quotes:
                return None, reason

        best = min(quotes, key=lambda q: (abs(q.leverage - self.settings.target_leverage), -q.bar.volume, q.item.symbol))
        choice = dict(symbol=best.item.symbol, effective_leverage=best.leverage, delta=best.delta,
                      reference_price=reference.close, premium=best.bar.close, volume=best.bar.volume)
        if self.settings.profile:
            reference_deviation, count = references[best.item.expiry_day]
            choice.update(profile=self.settings.profile, iv_preference=self.settings.iv_preference,
                          iv_ratio=best.deviation / reference_deviation, iv_reference_strikes=count,
                          expiry_day=best.item.expiry_day)
        return choice, ''

    def _open(self, source, direction, reason):
        choice, skip_reason = self._select(source, direction)
        if not choice:
            return self.ctx.emit('option_entry_skipped', signal_symbol=self.signal, source_contract=source,
                                 direction=direction, reason=skip_reason,
                                 **({'profile': self.settings.profile, 'iv_preference': self.settings.iv_preference}
                                    if self.settings.profile else {}))
        contract = choice['symbol']
        self.state = dict(contract=contract, source=source, direction=direction)
        signal = self.ctx.emit('target_position', **choice, target=1, signal_symbol=self.signal,
                               source_contract=source, direction=direction, reason=reason,
                               target_leverage=self.settings.target_leverage)
        self.state['entry'] = signal
        order = self.broker.target_position(contract, 1, now=self.ctx.now, signal_id=signal,
                                            reason=reason, immediate_entry=True)
        self.state.update(entry_order=order, entry_deadline=ceil(self.ctx.now / 60) * 60 + 60)
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
                    binding['next'] = (source, direction, reason) if direction else None
                    if pending and pending.target == 0:
                        return pending.id
                    exit_id = self.ctx.emit('target_position', symbol=contract, target=0,
                                            signal_symbol=self.signal, source_contract=binding['source'], reason=reason)
                    return self.broker.target_position(contract, 0, now=self.ctx.now, signal_id=exit_id, reason=reason)
            self.state = {}
        if direction:
            return self._open(source, direction, reason)
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
