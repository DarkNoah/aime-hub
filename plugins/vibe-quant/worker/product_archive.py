"""Fetch one bounded batch of closed one-minute TqSdk candles."""
import json
import math
import sys
import time

from common import bar, emit

MINUTE = 60


def window_size(previous, now, history_bars):
    if not previous:
        return history_bars
    # Wall time bounds the number of bars, including weekends and night sessions.
    return min(history_bars, max(2, math.ceil((now - previous) / MINUTE) + 2))


def archive_minutes(symbol, frame, previous, now):
    # Freeze the cutoff at request time so a slow batch cannot persist a partial candle.
    eligible = ((frame['datetime'] > previous * 1_000_000_000) &
                (frame['datetime'] <= (now - MINUTE) * 1_000_000_000) &
                (frame['id'] >= 0))
    latest = previous
    first = 0
    batch = []
    for row in frame[eligible].to_dict('records'):
        start = int(row['datetime']) // 1_000_000_000
        value = bar(symbol, MINUTE, start, row)
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
            symbol = target['symbol']
            length = window_size(target['latest'].get('60', 0), now, history_bars)
            try:
                frames[symbol] = api.get_kline_serial(symbol, MINUTE, data_length=length)
            except Exception:
                continue

    subscription = api.create_task(subscribe())
    deadline = time.monotonic() + 65
    remaining_errors = len(targets)
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

    for target in targets:
        symbol = target['symbol']
        latest = target['latest'].get('60', 0)
        first = 0
        outcome = 'error'
        frame = frames.get(symbol)
        if frame is not None and api.is_serial_ready(frame):
            try:
                first, latest = archive_minutes(symbol, frame, latest, now)
                outcome = 'ready' if latest else 'empty'
            except Exception:
                pass  # Retry this contract from its committed minute on the next run.
        emit('result', result=dict(symbol=symbol, latest={'60': latest} if latest else {},
                                   firstBarAt=first, lastBarAt=latest, outcome=outcome))


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
