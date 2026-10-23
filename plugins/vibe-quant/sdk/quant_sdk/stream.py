"""Polling transport with explicit cursor failure and closed-bar normalization."""
from collections import OrderedDict
from dataclasses import asdict
from hashlib import sha256
import json
from threading import Event as StopEvent

from .hub import DataError, PERIODS, convert_bar, event_for, three_minute
from .models import Bar, InstrumentUpdate, Quote, Roll


class HubStream:
    def __init__(self, client, symbols, *, calendar, rules, duration=60, poll_seconds=1, stop_event=None):
        if duration not in PERIODS or not 0 < poll_seconds <= 30:
            raise ValueError('Invalid live period or polling interval')
        self.client, self.calendar, self.rules = client, calendar, rules
        self.symbols = tuple(dict.fromkeys(symbols))
        self.duration, self.poll_seconds = duration, poll_seconds
        self.stop_event = stop_event if stop_event is not None else StopEvent()
        self._instruments = {s: client.rules(s, rules) for s in self.symbols}
        self._contracts = {}
        self._activation = {}
        self._quote_versions = {}
        self._bar_versions = OrderedDict()
        self._minutes = {}
        self._last_at = 0
        self.closed = False
        self.session = client.request('/sessions', method='POST', body={'symbols': list(self.symbols)})
        self.cursor, self.cutoff = self.session['cursor'], self.session['serverTime']
        self._initial = [{'quotes': self.session.get('initialQuotes', []), 'bars': [], 'receivedAt': self.cutoff}]

    @property
    def instruments(self):
        return tuple(self._instruments.values())

    def _register(self, symbol, when, day, output):
        if symbol not in self._instruments:
            item = self.client.rules(symbol, self.rules)
            self._instruments[symbol] = item
            self._activation[symbol] = when
            output.append(event_for(InstrumentUpdate(symbol, when, day, item), when))

    def _bar(self, bar, received, output):
        if bar.end_time <= self.cutoff or bar.end_time > received:
            return
        key = (bar.symbol, bar.duration, bar.time)
        digest = sha256(json.dumps(asdict(bar), sort_keys=True).encode()).hexdigest()
        if self._bar_versions.get(key) == digest:
            return
        self._bar_versions[key] = digest
        self._bar_versions.move_to_end(key)
        while len(self._bar_versions) > 50_000:
            self._bar_versions.popitem(last=False)
        output.append(event_for(bar, received))

    def poll(self):
        if self.closed or self.stop_event.is_set():
            return []
        response = self.client.request('/sessions/' + self.session['id'] + '/events', params={'cursor': self.cursor})
        if response['status']['state'] in ('error', 'standby'):
            raise DataError('LIVE_COLLECTOR_UNAVAILABLE')
        output = []
        for batch in [*self._initial, *response['batches']]:
            received = max(self._last_at, batch['receivedAt'])
            for row in batch['quotes']:
                symbol = row['symbol']
                if symbol not in self._instruments:
                    continue
                item = self._instruments[symbol]
                day = self.calendar.trading_day(row['time'], futures=item.kind != 'stock')
                received = max(received, row['time'])
                if item.kind == 'continuous':
                    contract = row.get('underlying')
                    if not contract:
                        raise DataError('Missing live main-contract mapping')
                    self._register(contract, received, day, output)
                    if self._contracts.get(symbol) != contract:
                        output.append(event_for(Roll(symbol, contract, row['time'], day), received))
                        self._contracts[symbol] = contract
                # Ignore stale initial quotes as signals, but retain their observed mapping.
                if row['time'] <= self.cutoff:
                    continue
                value = Quote(symbol, row['time'], day, row.get('last'), row.get('bid'), row.get('ask'))
                if self._quote_versions.get(symbol) != value:
                    output.append(event_for(value, received))
                    self._quote_versions[symbol] = value
            # The collector may return newest-first pages; normalize ordering first.
            rows = sorted(batch['bars'], key=lambda b: (b['time'] + min(b['duration'], 86400),
                          b['symbol'].startswith('KQ.m@'), b['symbol']))
            for row in rows:
                symbol = row['symbol']
                if symbol not in self._instruments:
                    continue
                requested = self.duration if symbol in self.symbols else 60
                execution = row['duration'] == 60 and self._instruments[symbol].tradable
                if not execution and row['duration'] != (60 if requested == 180 else requested):
                    continue
                cutoff = int(self.cutoff // 180 * 180) if requested == 180 else self.cutoff
                if row['duration'] < 86400 and row['time'] + row['duration'] <= cutoff:
                    continue
                if row['duration'] == 86400 and row['time'] < self.cutoff - 32 * 86400:
                    continue
                bar = convert_bar(row, self._instruments[symbol], self.calendar)
                if bar.end_time < self._activation.get(symbol, self.cutoff):
                    continue  # Initial history of a newly mapped contract is not a new live bar.
                # A later source update containing this bar after its close confirms it.
                # Do not finalize a pre-close snapshot on a local wall-clock timer.
                if bar.end_time > received:
                    continue
                if execution:
                    self._bar(bar, received, output)
                if requested == 180:
                    bucket = int(bar.time // 180 * 180)
                    minutes = self._minutes.setdefault((symbol, bucket), {})
                    minutes[bar.time] = bar
                    if all(bucket + n * 60 in minutes for n in range(3)):
                        parts = [minutes[bucket + n * 60] for n in range(3)]
                        aggregated = three_minute(parts)
                        if aggregated is not None:
                            self._bar(aggregated, received, output)
                    for key in list(self._minutes):
                        if key[1] < bucket - 86400:
                            del self._minutes[key]
                elif not execution:
                    self._bar(bar, received, output)
            self._last_at = received
        self.cursor = response['cursor']
        self._initial = []
        return output

    def __iter__(self):
        try:
            while not self.closed and not self.stop_event.is_set():
                yield from self.poll()
                self.stop_event.wait(self.poll_seconds)
        finally:
            self.close()

    def close(self):
        if not self.closed:
            self.closed = True
            try:
                self.client.request('/sessions/' + self.session['id'], method='DELETE')
            except DataError:
                pass  # The durable lease expires even if the collector disconnected.

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
