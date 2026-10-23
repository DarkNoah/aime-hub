"""Wire types use UTC epoch seconds, explicit trading dates and immutable records."""
from dataclasses import asdict, dataclass, field
from datetime import date
from math import isfinite
from typing import Any, Literal


def finite(value: float, name: str, positive: bool = False) -> None:
    if not isfinite(value) or (positive and value <= 0):
        raise ValueError(f"Invalid {name}")


@dataclass(frozen=True)
class Fees:
    per_unit: float = 0.0
    rate: float = 0.0
    minimum: float = 0.0
    close_today_per_unit: float | None = None
    close_today_rate: float | None = None
    sell_tax_rate: float = 0.0

    def __post_init__(self):
        for name, value in asdict(self).items():
            if value is not None and (not isfinite(value) or value < 0):
                raise ValueError(f"Invalid fee {name}")


@dataclass(frozen=True)
class Instrument:
    symbol: str
    kind: Literal['stock', 'future', 'continuous']
    price_tick: float
    multiplier: float | None = None
    lot_size: int | None = None
    margin_rate: float | None = None
    t_plus_one: bool | None = None
    tradable: bool = True
    fees: Fees = field(default_factory=Fees)

    def __post_init__(self):
        if not self.symbol or self.kind not in ('stock', 'future', 'continuous'):
            raise ValueError('Unsupported instrument')
        if self.kind == 'future' and (self.multiplier is None or self.margin_rate is None):
            raise ValueError('Futures require explicit multiplier and margin_rate')
        for name, default in (('multiplier', 1.0), ('margin_rate', 1.0),
                              ('lot_size', 100 if self.kind == 'stock' else 1),
                              ('t_plus_one', self.kind == 'stock')):
            if getattr(self, name) is None:
                object.__setattr__(self, name, default)
        for name in ('price_tick', 'multiplier', 'margin_rate'):
            finite(getattr(self, name), name, positive=True)
        if self.margin_rate > 1 or type(self.lot_size) is not int or self.lot_size < 1:
            raise ValueError('Invalid margin rate or lot size')
        if type(self.t_plus_one) is not bool or type(self.tradable) is not bool:
            raise ValueError('Invalid instrument flags')
        if self.kind == 'continuous':
            object.__setattr__(self, 'tradable', False)


@dataclass(frozen=True)
class Bar:
    symbol: str
    time: float
    end_time: float
    trading_day: str
    duration: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    is_final: bool = True

    def __post_init__(self):
        for name in ('time', 'end_time', 'open', 'high', 'low', 'close', 'volume'):
            finite(getattr(self, name), name)
        if (self.end_time <= self.time or self.duration <= 0 or self.volume < 0
                or self.low > min(self.open, self.close) or self.high < max(self.open, self.close)):
            raise ValueError('Invalid bar')


@dataclass(frozen=True)
class Quote:
    symbol: str
    time: float
    trading_day: str
    last: float | None = None
    bid: float | None = None
    ask: float | None = None

    def __post_init__(self):
        finite(self.time, 'quote time')
        for name in ('last', 'bid', 'ask'):
            if getattr(self, name) is not None:
                finite(getattr(self, name), name)


@dataclass(frozen=True)
class Roll:
    symbol: str
    contract: str
    time: float
    trading_day: str

    def __post_init__(self):
        finite(self.time, 'roll time')
        if not self.symbol or not self.contract:
            raise ValueError('Both continuous symbol and actual contract are required')


@dataclass(frozen=True)
class InstrumentUpdate:
    symbol: str
    time: float
    trading_day: str
    instrument: Instrument

    def __post_init__(self):
        finite(self.time, 'instrument time')
        if self.symbol != self.instrument.symbol:
            raise ValueError('Instrument identity mismatch')


@dataclass(frozen=True)
class Event:
    id: str
    available_at: float
    payload: Bar | Quote | Roll | InstrumentUpdate

    def __post_init__(self):
        finite(self.available_at, 'available_at')
        if not self.id or len(self.payload.trading_day) != 10:
            raise ValueError('Event identity and trading day are required')
        date.fromisoformat(self.payload.trading_day)
        observed = self.payload.end_time if isinstance(self.payload, Bar) and self.payload.is_final else self.payload.time
        if self.available_at < observed:
            raise ValueError('Event is available before its source time')

    def to_dict(self) -> dict[str, Any]:
        return {'id': self.id, 'available_at': self.available_at,
                'type': type(self.payload).__name__.lower(), 'payload': asdict(self.payload)}

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> 'Event':
        types = {'bar': Bar, 'quote': Quote, 'roll': Roll, 'instrumentupdate': InstrumentUpdate}
        payload = dict(value['payload'])
        if value['type'] == 'instrumentupdate':
            item = payload['instrument']
            payload['instrument'] = Instrument(**{**item, 'fees': Fees(**item.get('fees', {}))})
        return cls(value['id'], value['available_at'], types[value['type']](**payload))


@dataclass(frozen=True)
class RunConfig:
    initial_cash: float = 100_000.0
    start: float | None = None
    end: float | None = None
    slippage_ticks: float = 0.0
    participation_rate: float = 1.0
    annualization: int = 252
    risk_free_rate: float = 0.0
    benchmark_symbol: str | None = None
    history_limit: int = 10_000
    execution_duration: int = 60
    checkpoint_interval: float = 5.0
    dedup_limit: int = 50_000

    def __post_init__(self):
        finite(self.initial_cash, 'initial_cash', True)
        finite(self.slippage_ticks, 'slippage_ticks')
        finite(self.risk_free_rate, 'risk_free_rate')
        finite(self.checkpoint_interval, 'checkpoint_interval', True)
        if (self.slippage_ticks < 0 or not 0 < self.participation_rate <= 1
                or self.annualization <= 0 or self.history_limit < 1 or self.execution_duration <= 0):
            raise ValueError('Invalid run configuration')
        for name in ('history_limit', 'annualization', 'execution_duration', 'dedup_limit'):
            if type(getattr(self, name)) is not int or getattr(self, name) < 1:
                raise ValueError(f'Invalid {name}')
        for value in (self.start, self.end):
            if value is not None:
                finite(value, 'run time')
        if self.start is not None and self.end is not None and self.end < self.start:
            raise ValueError('End precedes start')
