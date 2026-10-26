"""The strategy only sees data already delivered by its runner's clock."""
from collections import OrderedDict
from dataclasses import asdict
from hashlib import sha256
from itertools import islice
import json
from pathlib import Path
from typing import Iterable

from .models import Bar, Event, Fees, Instrument, InstrumentUpdate, Quote, Roll


class DataView:
    def __init__(self, instruments: Iterable[Instrument], history_limit: int = 10_000):
        self._instruments = {item.symbol: item for item in instruments}
        self._bars: dict[tuple[str, int], OrderedDict[float, Bar]] = {}
        self._quotes: dict[str, Quote] = {}
        self._contracts: dict[str, str] = {}
        self._roll_times: dict[str, float] = {}
        self._subscriptions: set[tuple[str, int | None]] = set()
        self.now = 0.0
        self.history_limit = history_limit

    def instrument(self, symbol: str) -> Instrument:
        return self._instruments[symbol]

    def subscribe(self, symbol: str, duration: int | None = None) -> None:
        self.instrument(symbol)
        self._subscriptions.add((symbol, duration))

    def subscribed(self, payload: Bar | Quote | Roll) -> bool:
        return ((payload.symbol, None) in self._subscriptions or
                (isinstance(payload, Bar) and (payload.symbol, payload.duration) in self._subscriptions) or
                (isinstance(payload, Roll) and any(s == payload.symbol for s, _ in self._subscriptions)))

    def history(self, symbol: str, duration: int, count: int = 100,
                *, as_of: float | None = None) -> tuple[Bar, ...]:
        self.instrument(symbol)
        if count < 1:
            raise ValueError('count must be positive')
        end = self.now if as_of is None else as_of
        if end > self.now:
            raise ValueError('Future data is unavailable')
        # Read only the requested tail, preserving filtering and chronological order.
        # A long backtest otherwise scans the entire retained history on every bar.
        values = self._bars.get((symbol, duration), {}).values()
        tail = tuple(islice((bar for bar in reversed(values)
                            if bar.is_final and bar.end_time <= end), count))
        return tuple(reversed(tail))

    def quote(self, symbol: str) -> Quote | None:
        self.instrument(symbol)
        return self._quotes.get(symbol)

    def resolve_contract(self, symbol: str) -> str:
        item = self.instrument(symbol)
        if item.kind != 'continuous':
            return symbol
        if symbol not in self._contracts:
            raise ValueError(f'Missing point-in-time contract mapping: {symbol}')
        return self._contracts[symbol]

    def _apply(self, event: Event) -> tuple[bool, str | None]:
        """Corrections update history, but never re-execute a past bar's strategy."""
        value = event.payload
        if isinstance(value, InstrumentUpdate):
            previous = self._instruments.get(value.symbol)
            if previous is not None and previous != value.instrument:
                raise ValueError('Changing contract rules in-place is unsupported; start a new run')
            self._instruments[value.symbol] = value.instrument
            self.now = event.available_at
            return True, None
        self.instrument(value.symbol)
        self.now = event.available_at
        if isinstance(value, Bar):
            series = self._bars.setdefault((value.symbol, value.duration), OrderedDict())
            previous = series.get(value.time)
            latest = next(reversed(series), float('-inf'))
            correction = (previous is not None and previous.is_final) or value.time < latest
            if previous is not None and previous.is_final and not value.is_final:
                return True, None
            series[value.time] = value
            if value.time < latest:
                series = OrderedDict(sorted(series.items()))
                self._bars[(value.symbol, value.duration)] = series
            while len(series) > self.history_limit:
                series.popitem(last=False)
            return correction, None
        if isinstance(value, Quote):
            previous = self._quotes.get(value.symbol)
            if previous and value.time < previous.time:
                return True, None
            self._quotes[value.symbol] = value
            return False, None
        if self.instrument(value.symbol).kind != 'continuous' or self.instrument(value.contract).kind != 'future':
            raise ValueError('A futures continuous symbol must resolve to a futures contract')
        if value.symbol.startswith('KQ.m@'):
            family = value.symbol.removeprefix('KQ.m@')
            if not value.contract.startswith(family) or not value.contract[len(family):].isdigit():
                raise ValueError('Actual contract does not belong to the continuous product')
        previous = self._contracts.get(value.symbol)
        if value.time < self._roll_times.get(value.symbol, float('-inf')):
            return True, previous
        self._contracts[value.symbol] = value.contract
        self._roll_times[value.symbol] = value.time
        return previous == value.contract, previous


class Dataset:
    """Immutable input artifact, reusable by both backtest and live replay."""
    def __init__(self, instruments: Iterable[Instrument], events: Iterable[Event], *, metadata: dict | None = None):
        self.instruments = tuple(instruments)
        if len({item.symbol for item in self.instruments}) != len(self.instruments):
            raise ValueError('Duplicate instrument')
        self.events = tuple(sorted(events, key=lambda event: event.available_at))
        self.metadata = dict(metadata or {})

    def to_dict(self) -> dict:
        return {'schema_version': 1, 'instruments': [asdict(i) for i in self.instruments],
                'events': [e.to_dict() for e in self.events], 'metadata': self.metadata}

    @property
    def fingerprint(self) -> str:
        return sha256(json.dumps(self.to_dict(), sort_keys=True, allow_nan=False).encode()).hexdigest()

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), ensure_ascii=False, allow_nan=False), encoding='utf-8')

    @classmethod
    def load(cls, path: str | Path) -> 'Dataset':
        value = json.loads(Path(path).read_text(encoding='utf-8'))
        if value['schema_version'] != 1:
            raise ValueError('Unsupported dataset version')
        instruments = [Instrument(**{**item, 'fees': Fees(**item.get('fees', {}))}) for item in value['instruments']]
        return cls(instruments, (Event.from_dict(item) for item in value['events']), metadata=value.get('metadata'))

    @classmethod
    def from_run(cls, directory: str | Path) -> 'Dataset':
        """Replay the exact recorded arrival stream, including corrections and warm-up."""
        directory = Path(directory)
        manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
        instruments = [Instrument(**{**item, 'fees': Fees(**item.get('fees', {}))}) for item in manifest['instruments']]
        with (directory / 'events.jsonl').open(encoding='utf-8') as stream:
            events = [Event.from_dict(json.loads(line)) for line in stream if line.strip()]
        return cls(instruments, events, metadata={'source_run_id': manifest['run_id'],
                   'config': manifest['config'], 'params': manifest['params'],
                   'data_policy': 'recorded arrival stream'})
