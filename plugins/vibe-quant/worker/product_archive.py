"""Fetch one bounded batch of closed TqSdk candles; the host commits progress."""
import json
import math
import sys
import time
from datetime import datetime

from common import DURATIONS, TZ, bar, emit
from ticks import TickCalendar


def window_size(previous, duration, now, history_bars):
    if not previous:
        return history_bars
    # Wall time bounds the number of bars, including weekends and night sessions.
    return min(history_bars, max(2, math.ceil((now - previous) / duration) + 2))


def latest_is_closed(start, duration, now, calendar):
    if duration != 86400:
        return start + duration <= now
    # A daily candle can start on Friday evening and still trade on Monday.
    when = datetime.fromtimestamp(start, TZ)
    calendar.ensure(when.date(), when.date())
    trading_day = calendar.trading_day(when)
    return now >= datetime.fromisoformat(trading_day + 'T16:00:00').replace(tzinfo=TZ).timestamp()


def archive_period(symbol, duration, frame, previous, now, calendar):
    rows = frame[(frame['datetime'] > previous * 1_000_000_000) & (frame['id'] >= 0)].to_dict('records')
    latest = previous
    first = 0
    batch = []
    for index, row in enumerate(rows):
        start = int(row['datetime']) // 1_000_000_000
        if index == len(rows) - 1:
            try:
                closed = latest_is_closed(start, duration, now, calendar)
            except Exception:
                # An unavailable calendar only affects the newest daily candle.
                closed = False
            if not closed:
                break
        value = bar(symbol, duration, start, row)
        if value:
            first = first or start
            latest = start
            batch.append(value)
        if len(batch) == 1000:
            emit('bars', bars=batch)
            batch = []
    if batch:
        emit('bars', bars=batch)
    return first, latest


def collect(api, targets, history_bars):
    frames = {}
    now = int(time.time())

    async def subscribe():
        # Inside a Tq task get_kline_serial registers each subscription without
        # waiting for that individual series before requesting the next one.
        for target in targets:
            for duration in DURATIONS:
                key = (target['symbol'], duration)
                length = window_size(target['latest'].get(str(duration), 0), duration, now, history_bars)
                try:
                    frames[key] = api.get_kline_serial(key[0], duration, data_length=length)
                except Exception:
                    continue

    subscription = api.create_task(subscribe())
    deadline = time.monotonic() + 65
    remaining_errors = len(targets) * len(DURATIONS)
    while time.monotonic() < deadline:
        if subscription.done() and all(api.is_serial_ready(frame) for frame in frames.values()):
            break
        try:
            api.wait_update(deadline=time.time() + 1)
        except Exception:
            # The SDK reports individual chart-task failures here as well as
            # connection errors. Drain ready siblings even if a symbol is denied.
            remaining_errors -= 1
            if remaining_errors <= 0:
                break

    calendar = TickCalendar(api)
    # Use the original request time for the last bar. A slow batch must not
    # label a partially observed current candle closed just because time passed.
    for target in targets:
        symbol = target['symbol']
        latest = dict(target['latest'])
        first_minute = 0
        fetched = 0
        for duration in DURATIONS:
            frame = frames.get((symbol, duration))
            if frame is None or not api.is_serial_ready(frame):
                continue
            try:
                first, end = archive_period(symbol, duration, frame, latest.get(str(duration), 0), now, calendar)
            except Exception:
                continue
            fetched += 1
            if end:
                latest[str(duration)] = end
            if duration == 60:
                first_minute = first
        if not fetched:
            outcome = 'error'
        elif not latest:
            outcome = 'empty' if fetched == len(DURATIONS) else 'error'
        else:
            outcome = 'ready' if fetched == len(DURATIONS) and len(latest) == len(DURATIONS) else 'partial'
        emit('result', result=dict(symbol=symbol, latest=latest, firstBarAt=first_minute,
                                   lastBarAt=latest.get('60', 0), outcome=outcome))


def main():
    config = json.loads(sys.stdin.readline())
    sys.stdout = sys.stderr
    from tqsdk import TqApi, TqAuth
    api = TqApi(auth=TqAuth(config['tqUser'], config['tqPassword']))
    try:
        collect(api, config['targets'], config['historyBars'])
    finally:
        api.close()


if __name__ == '__main__':
    main()
