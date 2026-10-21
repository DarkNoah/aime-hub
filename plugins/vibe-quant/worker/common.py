"""Provider-neutral wire records and exchange-local session arithmetic."""
import json
import math
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Shanghai')
DURATIONS = (60, 300, 900, 1800, 3600, 86400)
STOCK_SESSIONS = {'day': [['09:30:00', '11:30:00'], ['13:00:00', '15:00:00']], 'night': []}
WIRE = sys.stdout


def emit(kind, **payload):
    WIRE.write(json.dumps({'type': kind, **payload}, ensure_ascii=False, allow_nan=False) + '\n')
    WIRE.flush()


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError):
        return None


def timestamp(value):
    """Source timestamps must include their date. Never turn an old quote into 'now'."""
    if not value or str(value) in ('nan', 'NaT', 'None'):
        return None
    try:
        dt = datetime.fromisoformat(str(value))
        return dt.replace(tzinfo=TZ).timestamp() if dt.tzinfo is None else dt.timestamp()
    except (ValueError, TypeError):
        return None


def in_session(now, sessions, calendar, before=0, after=0):
    """calendar maps exchange dates to bool; missing dates fail closed.

    Night sessions belong to the next trading day, including Friday to Monday.
    No night session starts before a holiday gap. End times may exceed 24:00.
    """
    now = now.astimezone(TZ)
    for offset in (-1, 0, 1):
        day = now.date() + timedelta(days=offset)
        midnight = datetime.combine(day, datetime.min.time(), TZ)
        for kind in ('day', 'night'):
            if not calendar.get(day.isoformat(), False):
                continue
            if kind == 'night':
                next_day = day + timedelta(days=1)
                while next_day.weekday() >= 5:
                    next_day += timedelta(days=1)
                if not calendar.get(next_day.isoformat(), False):
                    continue
            for start, end in sessions.get(kind, []):
                def seconds(text):
                    h, m, s = map(int, text.split(':'))
                    return h * 3600 + m * 60 + s
                a, b = seconds(start), seconds(end)
                if b < a:
                    b += 86400
                # 00:00-02:30 is a continuation of the prior evening session.
                if kind == 'night' and a < 12 * 3600:
                    a += 86400
                    b += 86400
                if midnight + timedelta(seconds=a, minutes=-before) <= now <= midnight + timedelta(seconds=b, minutes=after):
                    return True
    return False


def instrument(symbol, name, kind='stock', product='', price_tick=0.01, underlying='', expired=False):
    exchange = symbol.removeprefix('KQ.m@').split('.')[0]
    return dict(symbol=symbol, name=name if isinstance(name, str) else symbol, kind=kind, exchange=exchange,
                product=product if isinstance(product, str) else '', priceTick=number(price_tick) or 0.01,
                underlying=underlying if isinstance(underlying, str) else '', expired=bool(expired))


def quote(symbol, when, row, mapping, underlying=''):
    result = {'symbol': symbol, 'time': when, 'underlying': underlying or ''}
    for key in ('last', 'preClose', 'open', 'high', 'low', 'volume', 'amount', 'openInterest', 'bid', 'ask'):
        result[key] = number(row.get(mapping.get(key, key)))
    return result if when and result['last'] is not None else None


def bar(symbol, duration, when, row, volume='volume', amount_scale=1):
    values = {key: number(row.get(key)) for key in ('open', 'high', 'low', 'close')}
    if not when or any(value is None for value in values.values()):
        return None
    if values['low'] > min(values['open'], values['close']) or values['high'] < max(values['open'], values['close']):
        return None
    amount = number(row.get('amount'))
    amount = amount * amount_scale if amount is not None and amount >= 0 else None
    return dict(symbol=symbol, duration=duration, time=int(when), **values,
                volume=number(row.get(volume)) or 0, amount=number(amount))
