"""Lossless SDK tick identities and bounded rolling-window consumption.

Tick volume/amount remain cumulative. We do not manufacture individual trades.
"""
from bisect import bisect_left, bisect_right
from datetime import datetime, timedelta
from common import TZ, emit, number


def tick_targets(symbols, quotes):
    targets = {}
    for symbol, item in zip(symbols, quotes):
        kind = item.ins_class
        if kind == 'CONT':
            # Historical continuous data cannot be labelled with today's underlying.
            # Subscribe to the actual contract instead, including after a rollover.
            symbol = item.underlying_symbol
        elif kind not in ('FUTURE', 'OPTION', 'STOCK', 'FUND'):
            continue
        if symbol:
            targets[symbol] = item
    return targets


class TickCalendar:
    def __init__(self, api):
        self.api = api
        self.start = self.end = None
        self.days = []

    def ensure(self, first, last):
        if self.start is not None and self.start <= first and self.end >= last + timedelta(days=7):
            return
        self.start = min(first, self.start) if self.start else first
        self.end = max(last + timedelta(days=15), self.end) if self.end else last + timedelta(days=15)
        frame = self.api.get_trading_calendar(self.start, self.end)
        self.days = sorted(row['date'].date() for row in frame.to_dict('records') if row['trading'])

    def trading_day(self, when):
        # Domestic night trading starts after 18:00 and belongs to the next
        # trading day; Friday evening / Saturday morning both map to Monday.
        index = (bisect_right if when.hour >= 18 else bisect_left)(self.days, when.date())
        if index >= len(self.days):
            raise ValueError('Tick trading calendar does not cover source timestamp')
        day = self.days[index]
        if 6 <= when.hour < 18 and day != when.date():
            raise ValueError('Tick occurred outside a known trading day')
        return day.isoformat()


def normalize_tick(symbol, row, metadata, calendar, received_at):
    # to_dict('records') preserves integer columns; iterrows() would coerce the
    # nanosecond timestamp to float. Strings keep UInt64 exact across JSON/JS.
    tick_id, ns = int(row['id']), int(row['datetime'])
    when = datetime.fromtimestamp(ns // 1_000_000_000, TZ)
    return dict(
        symbol=symbol, tickId=str(tick_id), timeNs=str(ns),
        tradingDay=calendar.trading_day(when), receivedAt=received_at,
        last=number(row.get('last_price')), volume=number(row.get('volume')),
        amount=number(row.get('amount')), openInterest=number(row.get('open_interest')),
        bid=number(row.get('bid_price1')), bidVolume=number(row.get('bid_volume1')),
        ask=number(row.get('ask_price1')), askVolume=number(row.get('ask_volume1')),
        priceTick=number(metadata.get('price_tick')),
        volumeMultiple=number(metadata.get('volume_multiple')), volumeUnit='source',
    )


class TickCollector:
    def __init__(self, api, history_length):
        self.api = api
        self.history_length = history_length
        self.frames = {}
        self.cursors = {}
        self.calendar = TickCalendar(api)

    def collect(self, targets, received_at):
        for symbol, metadata in targets.items():
            if symbol not in self.frames:
                self.frames[symbol] = self.api.get_tick_serial(symbol, data_length=self.history_length)
            frame = self.frames[symbol]
            if not self.api.is_serial_ready(frame):
                continue
            cursor = self.cursors.get(symbol)
            # Other synchronous SDK requests can also drive wait_update.
            # Checking the tail ID catches updates consumed by those requests.
            tail_id = int(frame['id'].iloc[-1])
            if cursor == tail_id and not self.api.is_changing(frame):
                continue
            valid = frame[(frame['id'] >= 0) & (frame['datetime'] > 0)]
            if valid.empty:
                continue
            newest = int(valid['id'].iloc[-1])
            # Include the last observed row for a corrected last tick. Consume
            # ALL new rows, since one wait_update can deliver multiple ticks.
            rows = valid if cursor is None or newest < cursor else valid[valid['id'] >= cursor]
            records = rows.to_dict('records')
            if not records:
                continue
            dates = [datetime.fromtimestamp(int(row['datetime']) // 1_000_000_000, TZ).date()
                     for row in records]
            self.calendar.ensure(min(dates), max(dates))
            for offset in range(0, len(records), 2000):
                ticks = [normalize_tick(symbol, row, metadata, self.calendar, received_at)
                         for row in records[offset:offset + 2000]]
                emit('data', quotes=[], bars=[], ticks=ticks)
            self.cursors[symbol] = newest
