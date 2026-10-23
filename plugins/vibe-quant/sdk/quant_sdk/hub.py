"""Authenticated data adapter for the existing Vibe Quant market service."""
from dataclasses import asdict
from hashlib import sha256
import json
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .calendar import TradingCalendar
from .data import Dataset
from .models import Bar, Event, Instrument, Roll

RuleResolver = Callable[[str, dict], Instrument]
PERIODS = (60, 180, 300, 900, 1800, 3600, 86400)


class DataError(RuntimeError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def event_for(payload, available_at=None, *, revision='') -> Event:
    known = payload.end_time if isinstance(payload, Bar) and payload.is_final else payload.time
    available = known if available_at is None else max(known, available_at)
    identity = sha256(json.dumps([type(payload).__name__, asdict(payload), available, revision],
                                sort_keys=True, allow_nan=False).encode()).hexdigest()
    return Event(identity, available, payload)


def convert_bar(row: dict, item: Instrument, calendar: TradingCalendar) -> Bar:
    end, day = calendar.bar_end(row['time'], row['duration'], futures=item.kind != 'stock')
    return Bar(row['symbol'], row['time'], end, day, row['duration'],
               row['open'], row['high'], row['low'], row['close'], row['volume'])


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
                if not row['underlying']:
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
                 rules: RuleResolver, duration=60) -> Dataset:
        """Freeze latest-corrected bars and historically observed mappings, never current mappings."""
        if duration not in PERIODS:
            raise ValueError('Unsupported duration')
        instruments, events, requests = {}, [], set()
        for symbol in dict.fromkeys(symbols):
            item = instruments.setdefault(symbol, self.rules(symbol, rules))
            requests.add((symbol, duration))
            if item.tradable:
                requests.add((symbol, 60))
            if item.kind == 'continuous':
                mappings = list(self.contracts(symbol, start, end))
                if not mappings or mappings[0]['time'] > start:
                    raise DataError(f'No observed contract mapping at start for {symbol}')
                for mapping in mappings:
                    contract = mapping['underlying']
                    if contract not in instruments:
                        instruments[contract] = self.rules(contract, rules)
                    if instruments[contract].kind != 'future':
                        raise DataError('Main contracts must resolve to actual futures')
                    requests.add((contract, 60))
                    when = max(start, mapping['time'])
                    day = calendar.trading_day(when, futures=True)
                    events.append(event_for(Roll(symbol, contract, when, day)))
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
            if not count:
                raise DataError(f'No closed bars for {symbol} at {period}s; collect/import data first')
        # At equal timestamps: mappings, actual execution bars, signal-only continuous bars.
        events.sort(key=lambda e: (e.available_at, 0 if isinstance(e.payload, Roll) else
                                   2 if instruments[e.payload.symbol].kind == 'continuous' else 1))
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
            'source': 'vibe-quant', 'data_policy': 'latest-corrected frozen snapshot',
            'mapping_policy': 'observed quotes, no current-contract substitution',
            'calendar': calendar.to_dict(), 'start': start, 'end': end, 'duration': duration,
        })

    def stream(self, symbols, *, calendar: TradingCalendar, rules: RuleResolver, duration=60,
               poll_seconds=1, stop_event=None):
        from .stream import HubStream
        return HubStream(self, symbols, calendar=calendar, rules=rules, duration=duration,
                         poll_seconds=poll_seconds, stop_event=stop_event)
