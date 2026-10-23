"""Bar-based protective exits: causal levels, gap precedence, stop-first ambiguity."""
from .models import Bar


class ProtectionBook:
    def __init__(self):
        self.history: dict[str, list[dict]] = {}

    def update(self, record: dict):
        self.history.setdefault(record['entry_signal_id'], []).append(record)

    def at_open(self, time: float, entries: set[str]) -> dict[str, dict]:
        # A quote/fill callback inside a completed bar cannot change that bar's
        # earlier high/low. Such updates first apply to a subsequent full bar.
        return {entry: record for entry in entries
                if (record := next((r for r in reversed(self.history.get(entry, [])) if r['time'] <= time), None)) is not None}


def trigger(record: dict, side: int, bar: Bar, *, open_only: bool = False):
    stop, profit = record['stop_loss'], record['take_profit']
    # Open is the only known point before the intrabar extrema. Favorable gaps
    # through the target take priority over a stop touched later in this bar.
    if stop is not None and (bar.open <= stop if side > 0 else bar.open >= stop):
        return 'stop_loss', stop, bar.open, bar.time, 'open'
    if profit is not None and (bar.open >= profit if side > 0 else bar.open <= profit):
        return 'take_profit', profit, bar.open, bar.time, 'open'
    if open_only:
        return None
    if stop is not None and (bar.low <= stop if side > 0 else bar.high >= stop):
        return 'stop_loss', stop, stop, bar.end_time, 'bar'
    if profit is not None and (bar.high >= profit if side > 0 else bar.low <= profit):
        return 'take_profit', profit, profit, bar.end_time, 'bar'
    return None
