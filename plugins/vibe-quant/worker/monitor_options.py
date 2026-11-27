"""Read closed option-chain minutes from the same archive as SDK backtests."""

from quant_sdk import Bar
from quant_sdk.hub import event_for, option_bars
from quant_sdk.models import InstrumentUpdate, Roll
from quant_sdk.options import catalog_option, index_reference


def instruments(client, source, start, end, fees, calendar):
    for meta in client.option_chain(source, start, end):
        item = catalog_option(meta, source, fees, calendar)
        if item:
            yield item
            ref = index_reference(item)
            if ref and ref.symbol != source:
                yield ref


class LiveOptionEvents:
    """Capture the available chain at source-bar arrival, before spooling live events."""
    def __init__(self, stream, client, signal, fees, calendar, retained=None):
        self.stream, self.client, self.signal = stream, client, signal
        self.stop_event = stream.stop_event
        self.fees, self.calendar = fees, calendar
        self.retained = retained
        self.actual = None if signal.startswith('KQ.m@') else signal
        self.catalog_key = None
        self.refresh_at = 0
        self.items = {}
        self.last_minute = {}
        self.seen_bars = {}

    def __iter__(self):
        for event in self.stream:
            bar = event.payload
            if isinstance(bar, Roll) and bar.symbol == self.signal:
                self.actual = bar.contract
            if (isinstance(bar, Bar) and bar.duration == 60 and bar.symbol == self.actual
                    and bar.time > self.last_minute.get(self.actual, 0)):
                previous = self.last_minute.get(self.actual, bar.time)
                self.last_minute[self.actual] = bar.time
                key = self.actual, bar.trading_day
                if key != self.catalog_key or bar.time >= self.refresh_at:
                    self.catalog_key = key
                    self.refresh_at = bar.time + 900
                    # Continue valuing the previous month's option until expiry, even across a roll.
                    self.items = {s: i for s, i in self.items.items()
                                  if not i.expiry_day or i.expiry_day >= bar.trading_day}
                    if self.retained:
                        self.items[self.retained.symbol] = self.retained
                        self.retained = None
                    for item in instruments(self.client, self.actual, bar.time, bar.end_time, self.fees, self.calendar):
                        if item.symbol not in self.items:
                            self.items[item.symbol] = item
                            yield event_for(InstrumentUpdate(item.symbol, bar.time, bar.trading_day, item), event.available_at)
                # An option may be archived just after the source bar. Its late print
                # can value an existing position but cannot reopen a skipped signal.
                for option in option_bars(self.client, self.items, previous, bar.end_time, self.calendar):
                    if option.time > self.seen_bars.get(option.symbol, -1):
                        self.seen_bars[option.symbol] = option.time
                        yield event_for(option, event.available_at)
            yield event
