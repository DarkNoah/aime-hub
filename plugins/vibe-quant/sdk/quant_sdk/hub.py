"""Authenticated data adapter for the existing Vibe Quant market service."""
from collections import defaultdict
from datetime import datetime
from dataclasses import replace
from heapq import merge
from hashlib import sha256
import json
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .calendar import TradingCalendar
from .data import Dataset
from .options import catalog_option, index_reference
from .models import Bar, Event, Instrument, Roll, event_payload

RuleResolver = Callable[[str, dict], Instrument]
PERIODS = (60, 180, 300, 900, 1800, 3600, 86400)


class DataError(RuntimeError):
    pass


def mapped_future(client, symbol, rules, allow_gaps):
    if not symbol and allow_gaps:
        return None
    try:
        item = client.rules(symbol, rules)
    except RuntimeError as error:
        if allow_gaps and str(error) in ('INSTRUMENT_NOT_FOUND', 'INSTRUMENT_NOT_FOUND (HTTP 404)'):
            return None
        raise
    if item.kind != 'future':
        raise DataError('Main contracts must resolve to actual futures')
    return item


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def event_for(payload, available_at=None, *, revision='') -> Event:
    known = payload.end_time if isinstance(payload, Bar) and payload.is_final else payload.time
    available = known if available_at is None else max(known, available_at)
    identity = sha256(json.dumps([type(payload).__name__, event_payload(payload), available, revision],
                                sort_keys=True, allow_nan=False).encode()).hexdigest()
    return Event(identity, available, payload)


def convert_bar(row: dict, item: Instrument, calendar: TradingCalendar) -> Bar:
    end, day = calendar.bar_end(row['time'], row['duration'], futures=item.kind != 'stock')
    return Bar(row['symbol'], row['time'], end, day, row['duration'],
               row['open'], row['high'], row['low'], row['close'], row['volume'])


def option_bars(client, items, start, end, calendar):
    """Merge archived minutes with same-day volume observed strictly before the window."""
    def page(symbols):
        options = [s for s in symbols if items[s].kind == 'option']
        prefix = defaultdict(float)
        totals = {}
        if options:
            for row in client.option_volume_prefix(options, start):
                local = datetime.fromtimestamp(row['stamp'], calendar.timezone)
                day = (calendar.trading_day(row['stamp'], futures=True) if local.hour >= 18 or local.hour < 6
                       else local.date().isoformat())
                prefix[row['symbol'], day] += row['lots']
        for row in client.option_minute_rows(symbols, start, end):
            item = items[row['symbol']]
            bar = convert_bar(row, item, calendar)
            if bar.end_time <= end:
                if item.kind == 'option':
                    day, total = totals.get(bar.symbol, (None, 0))
                    if day != bar.trading_day:
                        total = prefix.pop((bar.symbol, bar.trading_day), 0)
                    total += bar.volume
                    totals[bar.symbol] = (bar.trading_day, total)
                    bar = replace(bar, day_volume=total)
                yield bar

    names = sorted(items)
    yield from merge(*(page(names[i:i + 48]) for i in range(0, len(names), 48)),
                     key=lambda bar: (bar.time, bar.symbol))


def three_minute(parts) -> Bar | None:
    parts = sorted(parts, key=lambda bar: bar.time)
    if len(parts) != 3 or len({bar.trading_day for bar in parts}) != 1:
        return None
    start = int(parts[0].time // 180 * 180)
    if [bar.time for bar in parts] != [start + n * 60 for n in range(3)]:
        return None
    return Bar(parts[0].symbol, start, parts[-1].end_time, parts[0].trading_day, 180,
               parts[0].open, max(p.high for p in parts), min(p.low for p in parts),
               parts[-1].close, sum(p.volume for p in parts))


class HubClient:
    allow_missing_mappings = False

    def __init__(self, base_url: str, *, headers: dict[str, str] | None = None, timeout=10):
        parsed = urlsplit(base_url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Use an HTTP(S) plugin API URL without credentials/query/fragment')
        self.base_url = base_url.rstrip('/')
        self.headers = dict(headers or {})
        self.timeout = timeout
        self._opener = build_opener(_NoRedirect())

    def request(self, path, *, method='GET', params=None, body=None):
        url = self.base_url + '/sdk' + path
        if params:
            url += '?' + urlencode(params)
        request = Request(url, method=method, headers={**self.headers, 'Content-Type': 'application/json'},
                          data=json.dumps(body, allow_nan=False).encode() if body is not None else None)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            # Never put credentials, response HTML or request headers into run artifacts.
            try:
                code = json.loads(error.read(4096)).get('code', 'HTTP_ERROR')
                if not isinstance(code, str) or not code.replace('_', '').isalnum():
                    code = 'HTTP_ERROR'
            except (ValueError, AttributeError):
                code = 'HTTP_ERROR'
            raise DataError(f'{code} (HTTP {error.code})') from None
        except (URLError, TimeoutError, OSError):
            raise DataError('MARKET_CONNECTION_FAILED') from None

    def instrument(self, symbol: str) -> dict:
        return self.request('/instruments/' + quote(symbol, safe=''))

    def rules(self, symbol: str, resolver: RuleResolver) -> Instrument:
        metadata = self.instrument(symbol)
        item = resolver(symbol, metadata)
        if item.symbol != symbol or item.kind != metadata['kind']:
            raise DataError('Instrument rules must match the data catalog')
        if item.kind == 'continuous' and not symbol.startswith('KQ.m@'):
            raise DataError('Only main-contract continuous series are supported')
        if item.tradable and (metadata.get('assetClass') == 'index' or symbol.startswith(('SSE.000', 'SZSE.399'))):
            raise DataError('An index can be a signal/benchmark but cannot be traded')
        return item

    def history(self, symbol: str, duration: int, start: float, end: float):
        if duration not in PERIODS or not 0 < start < end:
            raise ValueError('Invalid history window or duration')
        after = start - 1  # Market storage timestamps are integer UTC seconds.
        while True:
            page = self.request('/history', params={'symbol': symbol, 'duration': duration,
                                                  'after': after, 'before': end, 'limit': 1000})
            rows = page['bars']
            if any(row['symbol'] != symbol or row['duration'] != duration or
                   not after < row['time'] < end for row in rows):
                raise DataError('Invalid history page')
            yield from rows
            next_cursor = page.get('next')
            if next_cursor is None:
                break
            if next_cursor <= after:
                raise DataError('History pagination did not advance')
            after = next_cursor

    def contracts(self, symbol: str, start: float, end: float):
        params = {'symbol': symbol, 'from': start, 'to': end}
        previous = None
        while True:
            page = self.request('/contracts', params=params)
            for row in page['mappings']:
                if not row['underlying'] and not self.allow_missing_mappings:
                    raise DataError(f'Missing observed contract mapping for {symbol}')
                if row['underlying'] != previous:
                    yield row
                    previous = row['underlying']
            after = page.get('next')
            if after is None:
                break
            if after <= params.get('after', start):
                raise DataError('Contract pagination did not advance')
            params['after'] = after

    def snapshot(self, symbols, *, start: float, end: float, calendar: TradingCalendar,
                 rules: RuleResolver, duration=60, option_execution=False, skip_option_gaps=False) -> Dataset:
        """Freeze latest-corrected bars and historically observed mappings, never current mappings."""
        if duration not in PERIODS:
            raise ValueError('Unsupported duration')
        instruments, events, requests = {}, [], set()
        sparse = option_execution and skip_option_gaps
        symbols = list(dict.fromkeys(symbols))
        for symbol in symbols:
            item = instruments.setdefault(symbol, self.rules(symbol, rules))
            requests.add((symbol, duration))
            if item.tradable or (sparse and symbol == symbols[0]):
                requests.add((symbol, 60))
            if item.kind == 'continuous':
                mappings = list(self.contracts(symbol, start, end))
                if (not mappings or mappings[0]['time'] > start) and not sparse:
                    raise DataError(f'No observed contract mapping at start for {symbol}')
                for mapping in mappings:
                    contract = mapping['underlying']
                    mapped = instruments.get(contract) or mapped_future(self, contract, rules, sparse)
                    if mapped:
                        instruments[contract] = mapped
                        requests.add((contract, 60))
                    else:
                        contract = ''
                    when = max(start, mapping['time'])
                    day = calendar.trading_day(mapping['time'] if sparse else when, futures=True)
                    events.append(event_for(Roll(symbol, contract, when, day)))
        linked, chain_items = set(), {}
        if option_execution:
            signal = symbols[0]
            sources = {event.payload.contract for event in events if event.payload.symbol == signal and event.payload.contract}
            for source in sorted(sources or {signal}):
                for meta in self.option_chain(source, start, end):
                    linked.add(source)
                    symbol = meta['symbol']
                    if symbol in instruments:
                        continue
                    item = catalog_option(meta, source, instruments[source].fees, calendar)
                    if item is None:
                        continue
                    instruments[symbol] = item
                    chain_items[symbol] = item
                    ref = index_reference(item)
                    if ref and ref.symbol != source and (ref.symbol, 60) not in requests:
                        instruments.setdefault(ref.symbol, ref)
                        chain_items[ref.symbol] = instruments[ref.symbol]
            events.extend(event_for(bar) for bar in option_bars(self, chain_items, start, end, calendar))
            requests.update((source, 60) for source in linked)
        for symbol, period in sorted(requests):
            count = 0
            groups = {}
            for row in self.history(symbol, 60 if period == 180 else period, start, end):
                bar = convert_bar(row, instruments[symbol], calendar)
                if bar.end_time <= end:
                    if period == 180:
                        groups.setdefault(int(bar.time // 180), {})[bar.time] = bar
                    else:
                        events.append(event_for(bar))
                        count += 1
            for minutes in groups.values():
                bar = three_minute(minutes.values())
                if bar is not None:
                    events.append(event_for(bar))
                    count += 1
            if not count and instruments[symbol].kind != 'option' and not sparse:
                raise DataError(f'No closed bars for {symbol} at {period}s; collect/import data first')
        has_options = any(item.kind == 'option' for item in instruments.values())
        reference_symbols = {item.option_underlying for item in chain_items.values() if item.kind == 'option'}
        def priority(event):
            value = event.payload
            if isinstance(value, Roll):
                return 0
            kind = instruments[value.symbol].kind
            if kind == 'continuous':
                return 4
            if has_options:
                if kind == 'option' or (value.symbol in reference_symbols and value.symbol not in linked and value.duration == 60):
                    return 1
                return 2 if value.duration == 60 else 3
            return 1
        events.sort(key=lambda event: (event.available_at, priority(event)))
        if not sparse:
            execution_closes = {(e.payload.symbol, e.payload.end_time) for e in events
                                if isinstance(e.payload, Bar) and e.payload.duration == 60}
            observed = {}
            for event in events:
                value = event.payload
                if isinstance(value, Roll):
                    observed[value.symbol] = value.contract
                elif instruments[value.symbol].kind == 'continuous':
                    actual = observed.get(value.symbol)
                    if (actual, value.end_time) not in execution_closes:
                        raise DataError(f'Missing actual-contract execution bar for {value.symbol} at {value.end_time}')
        return Dataset(instruments.values(), events, metadata={
            **({'option_underlyings': sorted(linked)} if option_execution else {}),
            'source': 'vibe-quant', 'data_policy': 'latest-corrected frozen snapshot',
            'mapping_policy': 'observed quotes, no current-contract substitution',
            'calendar': calendar.to_dict(), 'start': start, 'end': end, 'duration': duration,
        })

    def option_volume_prefix(self, symbols, start):
        return self.request('/option-volume-prefix', params={'symbols': ','.join(symbols), 'start': int(start)})

    def option_minute_rows(self, symbols, start, end):
        params = {'symbols': ','.join(symbols), 'start': int(start), 'end': int(end)}
        while True:
            data = self.request('/option-minutes', params=params)
            yield from data['bars']
            if not data['next']:
                break
            params.update(data['next'])

    def option_chain(self, source, start, end):
        return self.request('/option-chain', params={'symbol': source, 'start': int(start), 'end': int(end)})

    def stream(self, symbols, *, calendar: TradingCalendar, rules: RuleResolver, duration=60,
               poll_seconds=1, stop_event=None):
        from .stream import HubStream
        return HubStream(self, symbols, calendar=calendar, rules=rules, duration=duration,
                         poll_seconds=poll_seconds, stop_event=stop_event)
