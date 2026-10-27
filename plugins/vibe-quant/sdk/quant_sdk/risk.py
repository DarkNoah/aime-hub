"""Causal protective levels shared by execution, exported results and charts."""
from dataclasses import dataclass
from hashlib import sha256
import json

from .models import finite


@dataclass(frozen=True)
class RiskLevels:
    """A complete replacement of the levels for an entry; None clears a level.

    entry_id accepts the ID from orders.target_position or an opening fill's
    signal_id. Omit it to update all currently open entries for this symbol.
    """
    symbol: str
    stop_loss: float | None = None
    take_profit: float | None = None
    entry_id: str | None = None

    def __post_init__(self):
        if not self.symbol or (self.entry_id is not None and not self.entry_id):
            raise ValueError('Risk levels require a symbol and a valid entry ID')
        for name in ('stop_loss', 'take_profit'):
            value = getattr(self, name)
            if value is not None:
                if isinstance(value, bool):
                    raise ValueError(f'Invalid {name}')
                finite(value, name)


def publish(context, levels: RiskLevels) -> None:
    runner = context._runner
    if context.warming_up or not context.event_id:
        raise ValueError('Risk levels require an active event callback')
    item = context.data.instrument(levels.symbol)
    if not runner.broker.points and (not item.tradable or item.kind == 'continuous'):
        raise ValueError('Risk levels require the actual tradable instrument')
    if levels.entry_id is None:
        entries = sorted({lot.signal_id for lot in runner.broker.lots if lot.symbol == levels.symbol})
        if not entries:
            raise ValueError('No open entry; pass entry_id from orders.target_position')
    else:
        entry = next((order.signal_id for order in runner.broker.orders if order.id == levels.entry_id), levels.entry_id)
        signal = next((s for s in reversed(runner.signals) if s['id'] == entry), None)
        if (not signal or signal['kind'] != 'target_position' or signal.get('symbol') != levels.symbol
                or not signal.get('target')):
            raise ValueError('Risk levels must reference a nonzero target_position for this instrument')
        entries = [entry]
    for entry in entries:
        payload = {'event_id': context.event_id, 'time': context.now, 'symbol': levels.symbol,
                   'entry_signal_id': entry, 'stop_loss': levels.stop_loss, 'take_profit': levels.take_profit}
        identity = sha256(json.dumps([runner.source_hash, runner.manifest['params'], payload, len(runner.risk_levels)],
                                    sort_keys=True, allow_nan=False).encode()).hexdigest()
        record = {'id': identity, **payload}
        runner.risk_levels.append(record)
        runner.broker.protection.update(record)
        runner._output('risk_levels', record)


def accept(context, value) -> None:
    if isinstance(value, RiskLevels):
        values = [value]
    elif isinstance(value, (list, tuple)) and any(isinstance(item, RiskLevels) for item in value):
        if not all(isinstance(item, RiskLevels) for item in value):
            raise TypeError('RiskLevels return lists cannot mix other result types')
        values = value
    else:
        # Older SDK versions ignored callback return values (e.g. an order ID).
        return
    for item in values:
        publish(context, item)
