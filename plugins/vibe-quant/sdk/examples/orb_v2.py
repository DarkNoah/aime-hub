"""ORB V2 for Vibe Quant: IM continuous signals, point-in-time actual execution.

Adapted from strategy_orb_v2.py. Uses the SDK's next-available-bar execution:
levels calculated after a fill or close apply to the next complete bar. The
initial bracket uses the signal close; the target is rebased to the fill price.
Protection is armed at bar close, not within the original OHLC path. The
configured deadline submits a close for the next available open. No real order
API is used. All tuning values come from the version's default parameters;
import orb_v2.parameters.json alongside this script when creating a strategy.
"""
from datetime import date, datetime, timedelta
from math import ceil, floor, isfinite
from zoneinfo import ZoneInfo

from quant_sdk import RiskLevels, Strategy


ZONE = ZoneInfo('Asia/Shanghai')
MINUTES = tuple(range(571, 691)) + tuple(range(781, 901))


def ticks(price):
    value = float(price)
    if not isfinite(value) or abs(value * 5 - round(value * 5)) > .005 + 1e-9:
        raise ValueError('IM price must be finite and aligned to 0.2')
    return round(value * 5)


def outward(price, side):
    return (ceil(price * 5 - 1e-8) if side > 0 else floor(price * 5 + 1e-8)) / 5


class OpeningRangeBreakoutV2(Strategy):
    def on_start(self, ctx):
        if ctx.params.get('symbol', 'KQ.m@CFFEX.IM') != 'KQ.m@CFFEX.IM':
            raise ValueError('ORB V2 requires KQ.m@CFFEX.IM as its signal symbol')
        if ctx.params.get('duration', 60) != 60:
            raise ValueError('ORB V2 requires one-minute bars')
        model = ctx.params.get('execution_model', 'actual_contract')
        if model not in ('actual_contract', 'continuous_price'):
            raise ValueError('Unknown execution model')
        if model == 'continuous_price' and (ctx.mode != 'backtest' or ctx.data.instrument('KQ.m@CFFEX.IM').kind != 'future'):
            raise ValueError('Continuous-price simulation requires a synthetic backtest dataset')
        for key in ('range_minutes', 'lookback', 'quantity', 'max_entries_per_day'):
            value = ctx.params.get(key)
            if type(value) is not int or value < 1:
                raise ValueError(f'{key} must be a positive integer')
        if ctx.params['range_minutes'] >= 120:
            raise ValueError('Opening range must finish before the morning close')
        for key in ('multiplier', 'reward_risk_ratio', 'protection_trigger_r', 'protection_points'):
            value = ctx.params.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or value <= 0:
                raise ValueError(f'{key} must be finite and positive')
        ticks(ctx.params['protection_points'])
        deadline = ctx.params.get('deadline')
        if (not isinstance(deadline, str) or len(deadline) != 5
                or deadline[2] != ':' or not (deadline[:2] + deadline[3:]).isdigit()):
            raise ValueError('deadline must use HH:MM Shanghai time')
        hour, minute = int(deadline[:2]), int(deadline[3:])
        deadline_minute = hour * 60 + minute
        if (hour > 23 or minute > 59 or deadline_minute not in MINUTES
                or deadline_minute in (690, 900)
                or deadline_minute <= 570 + ctx.params['range_minutes'] + 1):
            raise ValueError('deadline must follow the first entry bar and allow a later execution bar in the same session')
        ctx.state['deadline_minute'] = deadline_minute
        if ctx.data.history_limit < (ctx.params['lookback'] + 1) * 240:
            raise ValueError('History window is too small for the ORB warm-up')
        ctx.data.subscribe('KQ.m@CFFEX.IM', 60)
        ctx.state.setdefault('days', [])
        ctx.state.setdefault('trade', None)
        ctx.state.setdefault('used_day', None)
        ctx.state.setdefault('entries_today', 0)

    def on_ready(self, ctx):
        # Warm-up populates DataView without calling on_bar. Rebuild only from
        # already available main-contract bars, excluding the current event.
        if not ctx.state['days']:
            for bar in ctx.data.history('KQ.m@CFFEX.IM', 60, ctx.data.history_limit):
                if bar.end_time < ctx.now:
                    self._observe(ctx, bar)

    def _observe(self, ctx, bar):
        days = ctx.state['days']
        if not days or days[-1]['day'] != bar.trading_day:
            days.append({'day': bar.trading_day, 'count': 0, 'valid': True,
                         'high': None, 'low': None, 'last': None})
            del days[:-ctx.params['lookback'] - 2]
        current = days[-1]
        if current['last'] is not None and bar.end_time <= current['last']:
            return current
        stamp = datetime.fromtimestamp(bar.end_time, ZONE)
        index = current['count']
        valid = (index < 240 and stamp.date().isoformat() == bar.trading_day
                 and stamp.hour * 60 + stamp.minute == MINUTES[min(index, 239)]
                 and stamp.second == 0 and bar.end_time - bar.time == 60)
        try:
            op, hi, lo, cl = (ticks(getattr(bar, key)) for key in ('open', 'high', 'low', 'close'))
            valid = valid and lo <= min(op, cl) <= max(op, cl) <= hi
        except (ValueError, TypeError):
            valid = False
        current['valid'] = current['valid'] and valid
        if valid and index < ctx.params['range_minutes']:
            current['high'] = max(current['high'] if current['high'] is not None else hi, hi)
            current['low'] = min(current['low'] if current['low'] is not None else lo, lo)
        current['count'] += 1
        current['last'] = bar.end_time
        return current

    def _prior_days(self, ctx, day):
        supplied = ctx.params.get('trading_calendar')
        prior, cursor = [], date.fromisoformat(day)
        for _ in range(370):
            cursor -= timedelta(days=1)
            if supplied is not None:
                opened = supplied.get(cursor.isoformat())
                if type(opened) is not bool:
                    return None
            else:
                # Same calendar package as the host's snapshot preparation.
                # An explicit trading_calendar may override it for research.
                from chinese_calendar import is_holiday
                opened = cursor.weekday() < 5 and not is_holiday(cursor)
            if opened:
                prior.append(cursor.isoformat())
            if len(prior) == ctx.params['lookback']:
                return prior
        return None

    def _notice(self, ctx, reason):
        key = [ctx.trading_day, reason]
        if ctx.state.get('notice') != key:
            ctx.log(reason)
            ctx.state['notice'] = key

    def _levels(self, trade):
        return RiskLevels(trade['contract'], stop_loss=trade['stop'],
                          take_profit=trade['target'], entry_id=trade['entry_id'])

    def _close(self, ctx, trade, reason):
        if trade.get('closing'):
            return
        trade['closing'] = True
        if trade.get('order_id'):
            ctx.orders.cancel(trade['order_id'])
        ctx.orders.target_position(trade['contract'], 0, reason=reason)
        # Monitor has no broker position or fills; clear its signal-only state.
        if ctx.mode == 'monitor':
            ctx.state['trade'] = None

    def on_roll(self, ctx, event, previous_contract):
        trade = ctx.state['trade']
        if trade and previous_contract and previous_contract != event.contract:
            self._close(ctx, trade, 'orb_main_contract_roll')

    def on_order(self, ctx, order):
        trade = ctx.state.get('trade')
        if (trade and order['symbol'] == trade['contract'] and order['target'] != 0
                and order['status'] in ('rejected', 'cancelled')
                and not ctx.position(trade['contract'])):
            ctx.state['trade'] = None

    def on_fill(self, ctx, fill):
        trade = ctx.state.get('trade')
        if not trade or fill['symbol'] != trade['contract']:
            return
        if fill['offset'] == 'close':
            if not ctx.position(trade['contract']):
                ctx.state['trade'] = None
            return
        quantity = abs(fill['quantity'])
        total = trade.get('filled', 0) + quantity
        trade['entry'] = (trade.get('notional', 0) + quantity * fill['price']) / total
        trade['notional'] = trade['entry'] * total
        trade['filled'] = total
        trade['entry_id'] = fill['signal_id']
        risk = trade['side'] * (trade['entry'] - trade['stop'])
        trade['risk'] = risk
        if risk <= 0:
            # SDK entries fill at the next available open, including gaps.
            self._close(ctx, trade, 'orb_entry_gap_through_stop')
            return
        trade['target'] = outward(trade['entry'] + trade['side'] * risk * ctx.params['reward_risk_ratio'], trade['side'])
        return self._levels(trade)

    def on_bar(self, ctx, bar):
        if not bar.is_final:
            return
        main = 'KQ.m@CFFEX.IM'
        if bar.symbol != main:
            return
        current = self._observe(ctx, bar)
        stamp = datetime.fromtimestamp(bar.end_time, ZONE)
        minute = stamp.hour * 60 + stamp.minute
        trade = ctx.state['trade']
        if trade:
            if trade['day'] != bar.trading_day or minute >= ctx.state['deadline_minute']:
                self._close(ctx, trade, f"orb_{ctx.params['deadline'].replace(':', '_')}" if trade['day'] == bar.trading_day else 'orb_missing_deadline')
                return
            actual = ctx.data.history(trade['contract'], 60, 1)
            if not actual or actual[-1].end_time != bar.end_time or trade.get('closing'):
                return
            protection = ctx.params['protection_points']
            # Only filled positions can use entry-based protection. Cancel an
            # unfilled remainder so that a later fill cannot move the anchor.
            if trade.get('filled') and trade['risk'] * ctx.params['protection_trigger_r'] > protection and not trade.get('armed'):
                favorable = actual[-1].high if trade['side'] > 0 else actual[-1].low
                if trade['side'] * (favorable - trade['entry']) >= trade['risk'] * ctx.params['protection_trigger_r'] - 1e-9:
                    trade['armed'] = True
                    trade['stop'] = outward(trade['entry'] + trade['side'] * protection, trade['side'])
                    ctx.orders.cancel(trade['order_id'])
                    return self._levels(trade)
            return
        if ctx.state['used_day'] != bar.trading_day:
            ctx.state['used_day'] = bar.trading_day
            ctx.state['entries_today'] = 0
        if ctx.state['entries_today'] >= ctx.params['max_entries_per_day']:
            return
        opening = ctx.params['range_minutes']
        if minute < 570 + opening + 1 or minute >= ctx.state['deadline_minute'] or minute == 690:
            return
        if not current['valid'] or current['count'] < opening:
            self._notice(ctx, '当前主连分钟线缺口或非法报价，暂停当日开仓')
            return
        expected = self._prior_days(ctx, bar.trading_day)
        previous = {day['day']: day for day in ctx.state['days'][:-1]}
        if not expected or any(day not in previous or not previous[day]['valid'] or previous[day]['count'] != 240 for day in expected):
            self._notice(ctx, f"等待前{ctx.params['lookback']}个完整预期交易日；缺失交易日不跳过")
            return
        mean = sum(previous[day]['high'] - previous[day]['low'] for day in expected) / len(expected)
        width = current['high'] - current['low']
        if width <= 0 or width < mean * ctx.params['multiplier'] - 1e-8:
            return
        close = ticks(bar.close)
        side = 1 if close > current['high'] else -1 if close < current['low'] else 0
        if not side:
            return
        contract = ctx.data.resolve_contract(main)
        simulated = ctx.params.get('execution_model') == 'continuous_price' and contract == main
        if not simulated and (not contract.startswith('CFFEX.IM') or not contract[8:].isdigit()):
            raise ValueError('Historical main mapping must reference an actual IM contract')
        ctx.data.subscribe(contract, 60)
        actual = ctx.data.history(contract, 60, 1)
        if not actual or actual[-1].end_time != bar.end_time:
            self._notice(ctx, '实际合约缺少同步分钟线，暂停开仓')
            return
        reference = ticks(actual[-1].close) / 5
        # Translate the continuous box into the actual contract's coordinates
        # using only their simultaneous closes, never a present-day mapping.
        stop = ((current['low'] if side > 0 else current['high']) - close + ticks(actual[-1].close)) / 5
        risk = side * (reference - stop)
        trade = {'day': bar.trading_day, 'contract': contract, 'side': side,
                 'stop': stop, 'target': outward(reference + side * risk * ctx.params['reward_risk_ratio'], side),
                 'entry': reference, 'risk': risk, 'filled': 0, 'armed': False}
        ctx.emit('orb_breakout', source_symbol=main, symbol=contract, side='long' if side > 0 else 'short',
                 box_high=current['high'] / 5, box_low=current['low'] / 5,
                 previous_mean=mean / 5, stop_loss=stop, take_profit=trade['target'])
        ctx.state['entries_today'] += 1
        ctx.state['trade'] = trade
        order_id = ctx.orders.target_position(contract, side * ctx.params['quantity'], reason='orb_breakout')
        trade['entry_id'] = trade['order_id'] = order_id
        return self._levels(trade)
