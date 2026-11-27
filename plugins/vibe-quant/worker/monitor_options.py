"""Read closed option-chain minutes from the same archive as SDK backtests."""

from quant_sdk import Bar
from quant_sdk.hub import event_for, option_bars
from quant_sdk.models import InstrumentUpdate, Quote, Roll
from quant_sdk.options import catalog_option, index_reference, index_chain


def instruments(client, source, start, end, fees, calendar):
    for meta in client.option_chain(source, start, end):
        item = catalog_option(meta, source, fees, calendar)
        if item:
            yield item
            ref = index_reference(item)
            if ref and ref.symbol != source:
                yield ref


class MarketOptionCoverage:
    """Hold auxiliary bars until the signal, mapped future and an option share a closed minute."""
    def __init__(self, runner):
        self.router = runner.option_router
        self.data = runner.data
        self.minute_end = self.covered_end = None
        self.pending = []
        self.minutes = {}
        if self.router:
            self.router.allow_unsettled_expiry = True

    def has_prices(self, day):
        router = self.router
        signal = router.signal
        actual = self.data._contracts.get(signal) if self.data.instrument(signal).kind == 'continuous' else signal
        if actual not in self.minutes:
            return False
        chain = index_chain(actual)
        candidates = router.by_month.get(chain, ()) if chain else router.by_underlying.get(actual, ())
        bound = router.state.get('contract')
        if bound and router.broker.position(bound):
            expiry = self.data.instrument(bound).expiry_day
            if not expiry or expiry >= day:
                candidates = (bound,)
        for symbol in candidates:
            bar = self.minutes.get(symbol)
            if bar and bar.day_volume is not None and self.data.instrument(symbol).option_underlying in self.minutes:
                return True
        return False

    def accept(self, event):
        if not self.router:
            return (event,)
        bar = event.payload
        if isinstance(bar, (InstrumentUpdate, Roll)):
            if isinstance(bar, Roll) and bar.symbol == self.router.signal:
                self.pending.clear()
                self.minutes.clear()
                self.covered_end = None
            return (event,)
        if isinstance(bar, Quote):
            return (event,) if not self.pending and self.covered_end is not None and 0 <= event.available_at - self.covered_end < 60 else ()
        if not bar.is_final or (self.minute_end is not None and bar.end_time < self.minute_end):
            return ()
        if bar.end_time != self.minute_end:
            self.minute_end = bar.end_time
            self.pending.clear()
            self.minutes.clear()
        expiry = self.data.instrument(bar.symbol).expiry_day
        if expiry and bar.trading_day > expiry:
            return ()
        if self.covered_end == self.minute_end:
            return (event,)
        if bar.duration == 60 and bar.close > 0:
            self.minutes[bar.symbol] = bar
        self.pending.append(event)
        if bar.symbol != self.router.signal or not self.has_prices(bar.trading_day):
            return ()
        self.covered_end = self.minute_end
        batch, self.pending = self.pending, []
        # A delayed leg makes the batch actionable only at its arrival; never
        # backdate an auxiliary callback or a fill to an already skipped instant.
        return [item if item.available_at == event.available_at else event_for(item.payload, event.available_at)
                for item in batch]


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
                    self.refresh_at = bar.time + 60
                    # Continue valuing the previous month's option until expiry, even across a roll.
                    self.items = {s: i for s, i in self.items.items()
                                  if not i.expiry_day or i.expiry_day >= bar.trading_day}
                    if self.retained:
                        self.items[self.retained.symbol] = self.retained
                        self.retained = None
                    for item in instruments(self.client, self.actual, bar.time, bar.end_time, self.fees, self.calendar):
                        self.refresh_at = bar.time + 900
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
