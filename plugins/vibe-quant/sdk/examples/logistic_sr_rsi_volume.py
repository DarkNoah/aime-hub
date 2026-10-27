# Support/resistance model ported from web/indicators/main/logistic-sr/engine.ts,
# adapted from “Support and Resistance Logistic Regression | Flux Charts”.
# © fluxchart. This Source Code Form is subject to the terms of the Mozilla
# Public License, v. 2.0: https://mozilla.org/MPL/2.0/.
"""Confirmed S/R retests, Wilder RSI and prior-volume filters; no backpainting.

Single-file strategy for the strategy library. Import the accompanying JSON as
default parameters. Model scores preserve the indicator's unconventional update
and are not calibrated trade win probabilities. All mutable state is JSON-safe.
"""
from datetime import datetime
from math import ceil, exp, floor, isfinite, log1p
from zoneinfo import ZoneInfo

from quant_sdk import RiskLevels, Strategy


ZONE = ZoneInfo('Asia/Shanghai')


def sigmoid(value):
    if value >= 0:
        return 1 / (1 + exp(-value))
    power = exp(value)
    return power / (1 + power)


def features(state, bar, length):
    """Wilder seeds match the chart (ATR N ranges, RSI N close changes)."""
    index = state.get('count', 0)
    previous = state.get('close')
    tr = bar.high - bar.low
    if previous is not None:
        tr = max(tr, abs(bar.high - previous), abs(bar.low - previous))
    atr = state.get('atr', 0)
    atr = atr + tr / length if index < length else (atr * (length - 1) + tr) / length
    gain, loss = state.get('gain', 0), state.get('loss', 0)
    if previous is not None:
        change = bar.close - previous
        if index <= length:
            gain += max(change, 0) / length
            loss += max(-change, 0) / length
        else:
            gain = (gain * (length - 1) + max(change, 0)) / length
            loss = (loss * (length - 1) + max(-change, 0)) / length
    rsi = (0 if index < length or (gain == 0 and loss == 0) else
           100 if loss == 0 else 100 - 100 / (1 + gain / loss))
    state.update(count=index + 1, close=bar.close, atr=atr, gain=gain, loss=loss, rsi=rsi)
    return rsi, atr if index >= length - 1 else None


def predict(levels, indices, candidate, target):
    # Deliberately preserve the chart's self-training, -1/+1 labels and
    # (p + loss) update. Replacing this with standard sklearn LR changes it.
    rsi_bias = body_bias = 1.0
    for index in indices:
        level = levels[index]
        y = 1 if level['timesRespected'] >= target else -1
        z = 1 + rsi_bias * level['detectedRSI'] + body_bias * level['detectedBodySize']
        loss = max(z, 0) + log1p(exp(-abs(z))) - y * z
        step = .008 * (sigmoid(z) + loss)
        rsi_bias -= step * level['detectedRSI']
        body_bias -= step * level['detectedBodySize']
    z = 1 + rsi_bias * candidate['detectedRSI'] + body_bias * candidate['detectedBodySize']
    if not isfinite(z):
        raise ValueError('S/R model overflow; indicator history is too long')
    return sigmoid(z)


def observe(state, bar, params):
    """Consume one closed bar; return only events knowable at this close."""
    if bar.end_time <= state.get('last', -1):
        return None
    index = state.get('count', 0)
    length = params['pivot_length']
    rsi, atr = features(state.setdefault('features', {}), bar, length)
    filter_state = state.setdefault('filter_features', {})
    previous_rsi = filter_state.get('rsi')
    filter_rsi, _ = features(filter_state, bar, params['rsi_length'])
    volumes = state.setdefault('volumes', [])
    mean_volume = sum(volumes) / len(volumes) if len(volumes) == params['volume_length'] else None
    volumes.append(bar.volume)
    del volumes[:-params['volume_length']]
    window = state.setdefault('window', [])
    window.append({'open': bar.open, 'high': bar.high, 'low': bar.low, 'close': bar.close, 'rsi': rsi})
    del window[:-2 * length - 1]
    levels = state.setdefault('levels', [])
    active = state.setdefault('active', [])
    if len(window) == 2 * length + 1:
        pivot = window[length]
        for support in (False, True):
            key = 'low' if support else 'high'
            value = pivot[key]
            left, right = window[:length], window[length + 1:]
            valid = (all(b[key] >= value for b in left) and all(b[key] > value for b in right) if support
                     else all(b[key] <= value for b in left) and all(b[key] < value for b in right))
            if not valid:
                continue
            level = {'isSupport': support, 'level': value, 'startIndex': index - length,
                     'confirmedIndex': index, 'timesRespected': 0, 'detectedRSI': 1 if pivot['rsi'] > 50 else -1,
                     'detectedBodySize': 1 if abs(pivot['close'] - pivot['open']) > atr else -1,
                     'latestRetestIndex': 0}
            indices = state.setdefault('supports' if support else 'resistances', [])
            indices.append(len(levels))
            active.append(len(levels))
            levels.append(level)
            level['detectedPrediction'] = predict(levels, indices, level, params['target_respects'])
            level['detectedByRegression'] = level['detectedPrediction'] >= params['probability_threshold']
    events, remaining = [], []
    for level_index in active:
        level = levels[level_index]
        crossed = bar.low < level['level'] if level['isSupport'] else bar.high > level['level']
        respected = bar.close > level['level'] if level['isSupport'] else bar.close < level['level']
        if crossed and not respected:
            level['endIndex'] = index
            if level['detectedByRegression']:
                events.append({'index': index, 'type': 'break', 'level': dict(level)})
            continue
        if crossed:
            if level['detectedByRegression'] and index > level['latestRetestIndex'] + 3:
                level['latestRetestIndex'] = index
                events.append({'index': index, 'type': 'retest', 'level': dict(level)})
            level['timesRespected'] += 1
        remaining.append(level_index)
    state.update(active=remaining, count=index + 1, last=bar.end_time)
    return {'events': events, 'atr': atr, 'rsi': filter_rsi, 'previous_rsi': previous_rsi,
            'rsi_ready': index > params['rsi_length'], 'mean_volume': mean_volume}


def rsi_allows(side, snapshot, params):
    if not params['rsi_filter']:
        return True
    if not snapshot['rsi_ready']:
        return False
    rsi, previous = snapshot['rsi'], snapshot['previous_rsi']
    return (rsi <= params['long_rsi_max'] and rsi > previous if side > 0
            else rsi >= params['short_rsi_min'] and rsi < previous)


def volume_allows(volume, snapshot, params):
    if not params['volume_filter']:
        return True
    mean = snapshot['mean_volume']
    return mean is not None and mean > 0 and volume >= mean * params['volume_ratio']


def outward(price, tick, direction):
    return (ceil(price / tick - 1e-8) if direction > 0 else floor(price / tick + 1e-8)) * tick


class LogisticSRRSIVolume(Strategy):
    def on_start(self, ctx):
        p = ctx.params
        for key in ('duration', 'pivot_length', 'target_respects', 'rsi_length', 'volume_length',
                    'quantity', 'max_entries_per_day'):
            if type(p.get(key)) is not int or p[key] < 1:
                raise ValueError(f'{key} must be a positive integer')
        for key in ('probability_threshold', 'volume_ratio', 'stop_atr_buffer', 'reward_risk_ratio'):
            if isinstance(p.get(key), bool) or not isinstance(p.get(key), (int, float)) or not isfinite(p[key]) or p[key] <= 0:
                raise ValueError(f'{key} must be finite and positive')
        if p['probability_threshold'] > 1:
            raise ValueError('probability_threshold must not exceed 1')
        for key in ('long_rsi_max', 'short_rsi_min'):
            if not isinstance(p.get(key), (int, float)) or not 0 <= p[key] <= 100:
                raise ValueError(f'{key} must be between 0 and 100')
        for key in ('rsi_filter', 'volume_filter'):
            if type(p.get(key)) is not bool:
                raise ValueError(f'{key} must be boolean')
        deadline = datetime.strptime(p['deadline'], '%H:%M')
        minute = deadline.hour * 60 + deadline.minute
        if p['duration'] % 60 or p['duration'] > 900 or not 780 < minute <= 885 or minute % (p['duration'] // 60):
            raise ValueError('Use 1–15 minute bars and an aligned afternoon deadline no later than 14:45')
        if not (p['symbol'] == 'KQ.m@CFFEX.IM' or
                (p['symbol'].startswith('CFFEX.IM') and p['symbol'][8:].isdigit())):
            raise ValueError('This strategy supports IM futures or IM main signals')
        ctx.data.subscribe(p['symbol'], p['duration'])
        ctx.state.setdefault('model', {})
        ctx.state.setdefault('trade', None)
        ctx.state.setdefault('day', None)
        ctx.state.setdefault('entries', 0)
        ctx.state.setdefault('counts', {'retests': 0, 'rsi_pass': 0, 'volume_pass': 0, 'entries': 0})
        ctx.state['deadline'] = minute

    def on_ready(self, ctx):
        if not ctx.state['model']:
            for bar in ctx.data.history(ctx.params['symbol'], ctx.params['duration'], ctx.data.history_limit):
                if bar.end_time < ctx.now:
                    observe(ctx.state['model'], bar, ctx.params)

    def _levels(self, trade):
        return RiskLevels(trade['contract'], stop_loss=trade['stop'], take_profit=trade['target'], entry_id=trade['entry_id'])

    def _close(self, ctx, trade, reason):
        if trade.get('closing'):
            return
        trade['closing'] = True
        if trade.get('order_id'):
            ctx.orders.cancel(trade['order_id'])
        ctx.orders.target_position(trade['contract'], 0, reason=reason)
        if ctx.mode == 'monitor':
            ctx.state['trade'] = None

    def on_order(self, ctx, order):
        trade = ctx.state.get('trade')
        if (trade and order['symbol'] == trade['contract'] and order['target'] != 0
                and order['status'] in ('rejected', 'cancelled') and not ctx.position(trade['contract'])):
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
        trade['filled'] = trade.get('filled', 0) + quantity
        trade['notional'] = trade.get('notional', 0) + quantity * fill['price']
        entry = trade['notional'] / trade['filled']
        risk = trade['side'] * (entry - trade['stop'])
        trade['entry_id'] = fill['signal_id']
        if risk <= 0:
            self._close(ctx, trade, 'lr_sr_entry_gap_through_stop')
            return
        tick = ctx.data.instrument(trade['contract']).price_tick
        trade['target'] = outward(entry + trade['side'] * risk * ctx.params['reward_risk_ratio'], tick, trade['side'])
        return self._levels(trade)

    def on_roll(self, ctx, event, previous_contract):
        trade = ctx.state.get('trade')
        if trade and previous_contract and previous_contract != event.contract:
            self._close(ctx, trade, 'lr_sr_main_roll')

    def on_bar(self, ctx, bar):
        p, state = ctx.params, ctx.state
        if not bar.is_final or bar.symbol != p['symbol'] or bar.duration != p['duration']:
            return
        snapshot = observe(state['model'], bar, p)
        if snapshot is None:
            return
        stamp = datetime.fromtimestamp(round(bar.end_time), ZONE)
        minute = stamp.hour * 60 + stamp.minute
        if state['day'] != bar.trading_day:
            state.update(day=bar.trading_day, entries=0)
        trade = state['trade']
        if trade:
            if trade['day'] != bar.trading_day or minute >= state['deadline']:
                self._close(ctx, trade, 'lr_sr_session_close')
            return
        if not (570 < minute < 690 or 780 < minute < state['deadline']):
            return
        if state['entries'] >= p['max_entries_per_day'] or snapshot['atr'] is None or snapshot['atr'] <= 0:
            return
        candidates = [e['level'] for e in snapshot['events'] if e['type'] == 'retest']
        if not candidates:
            return
        state['counts']['retests'] += 1
        candidates = [level for level in candidates if rsi_allows(1 if level['isSupport'] else -1, snapshot, p)]
        if not candidates:
            return
        state['counts']['rsi_pass'] += 1
        if not volume_allows(bar.volume, snapshot, p):
            return
        state['counts']['volume_pass'] += 1
        # Skip an ambiguous bar retesting both sides. Otherwise prefer the
        # closest accepted level, with a deterministic newest-level tie break.
        if len({level['isSupport'] for level in candidates}) != 1:
            return
        level = min(candidates, key=lambda item: (abs(bar.close - item['level']), -item['confirmedIndex']))
        side = 1 if level['isSupport'] else -1
        contract = ctx.data.resolve_contract(bar.symbol)
        instrument = ctx.data.instrument(contract)
        if instrument.kind != 'future':
            raise ValueError('Execution requires an actual future or a synthetic continuous-price backtest')
        ctx.data.subscribe(contract, 60)
        # Main/actual price coordinates are translated using simultaneous
        # closes only. No current-day underlying is used for historical bars.
        actual = ctx.data.history(contract, 60, 1)
        if not actual or abs(actual[-1].end_time - bar.end_time) > .00001:
            return
        reference = actual[-1].close
        source_stop = (bar.low - snapshot['atr'] * p['stop_atr_buffer'] if side > 0
                       else bar.high + snapshot['atr'] * p['stop_atr_buffer'])
        stop = outward(reference + source_stop - bar.close, instrument.price_tick, -side)
        risk = side * (reference - stop)
        if risk < instrument.price_tick:
            return
        target = outward(reference + side * risk * p['reward_risk_ratio'], instrument.price_tick, side)
        trade = {'contract': contract, 'day': bar.trading_day, 'side': side, 'stop': stop, 'target': target}
        ctx.emit('logistic_sr_retest', source_symbol=bar.symbol, symbol=contract, side='long' if side > 0 else 'short',
                 level=level['level'], probability=level['detectedPrediction'], confirmed_index=level['confirmedIndex'],
                 rsi=snapshot['rsi'], volume_ratio=bar.volume / snapshot['mean_volume'] if snapshot['mean_volume'] else None,
                 stop_loss=stop, take_profit=target)
        state['trade'] = trade
        state['entries'] += 1
        state['counts']['entries'] += 1
        entry = ctx.orders.target_position(contract, side * p['quantity'], reason='logistic_sr_retest')
        trade['entry_id'] = trade['order_id'] = entry
        return self._levels(trade)

    def on_stop(self, ctx, reason):
        ctx.log('S/R filter counts (eligible flat-position bars)', **ctx.state.get('counts', {}))
