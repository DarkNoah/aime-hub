"""Display valuations use entry cost, independently of daily settlement basis."""
from math import isfinite


def open_valuation(runner, lot):
    broker = runner.broker
    quote = getattr(broker, 'quote', None)
    price = getattr(quote, 'last_price', None) if quote is not None else None
    if quote is None:
        quote = runner.data.quote(lot.symbol)
        bars = runner.data.history(lot.symbol, 60, 1)
        boundary = max(lot.entry_time, bars[-1].end_time if bars else lot.entry_time)
        if quote is not None and quote.time >= boundary:
            price = quote.last
    if price is None or not isfinite(price):
        price = broker.marks.get(lot.symbol)
    multiplier = 1 if getattr(broker, 'points', False) else runner.data.instrument(lot.symbol).multiplier
    valid = price is not None and isfinite(price)
    return {'mark_price': price if valid else None, 'pnl_multiplier': multiplier,
            'unrealized_pnl': (price - lot.entry_price) * lot.quantity * multiplier - lot.entry_fee if valid else None}


def exit_valuation(runner, signal, side, price):
    """Value only the quantity being reduced, FIFO, before the intent is filled.

    Includes paid entry fees. Exit costs and slippage are not yet known.
    """
    if runner is None or price is None or not isfinite(price) or side == 'unknown':
        return None
    symbol = signal['symbol']
    direction = 1 if side == 'long' else -1
    lots = [lot for lot in runner.broker.lots if lot.symbol == symbol and lot.quantity * direction > 0
            and (signal.get('entry_signal_id') is None or lot.signal_id == signal['entry_signal_id'])]
    quantity = sum(abs(lot.quantity) for lot in lots)
    if signal['kind'] == 'target_position':
        quantity = max(0, quantity - max(0, signal['target'] * direction))
    if not quantity:
        return None
    points = getattr(runner.broker, 'points', False)
    multiplier = 1 if points else runner.data.instrument(symbol).multiplier
    value = 0
    for lot in lots:
        size = min(quantity, abs(lot.quantity))
        value += (price - lot.entry_price) * direction * size * multiplier - lot.entry_fee * size / abs(lot.quantity)
        quantity -= size
        if not quantity:
            break
    return {'value': value, 'unit': 'points' if points else 'currency', 'basis': 'estimate'}
