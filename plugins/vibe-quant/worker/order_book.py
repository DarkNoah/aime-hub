"""Depth snapshots retain source units and never infer exchange time from receipt time."""
import time
from uuid import uuid4
from common import number


def snapshot(symbol, row, source_time, *, levels=5, price_key='{side}_price{level}',
             volume_key='{side}_volume{level}', volume_unit='source', underlying='', received_at=None):
    result = dict(snapshotId=str(uuid4()), symbol=symbol, sourceTime=source_time,
                  receivedAt=time.time() if received_at is None else received_at,
                  timePrecision='exchange' if source_time is not None else 'unknown',
                  volumeUnit=volume_unit, underlying=underlying if isinstance(underlying, str) else '')
    for side in ('bid', 'ask'):
        prices, volumes = [], []
        for level in range(1, levels + 1):
            price = number(row.get(price_key.format(side=side, level=level)))
            volume = number(row.get(volume_key.format(side=side, level=level)))
            # Zero is the stock protocol's empty-price sentinel; keep zero volume
            # when a valid price exists, but never present a queue at a missing price.
            valid = price is not None and price > 0
            prices.append(price if valid else None)
            volumes.append(volume if valid and volume is not None and volume >= 0 else None)
        result[side + 'Prices'] = prices
        result[side + 'Volumes'] = volumes
    return result


def tq_book(symbol, row, source_time, received_at=None):
    return snapshot(symbol, row, source_time, underlying=row.get('underlying_symbol', ''), received_at=received_at)


def tdx_book(symbol, row, received_at=None):
    # Standard PyTDX quotes have no reliable full exchange date/time. Retain
    # original queue-size units and save each observation under a separate ID.
    return snapshot(symbol, row, None, price_key='{side}{level}', volume_key='{side}_vol{level}', received_at=received_at)


def tushare_book(symbol, row, source_time, received_at=None):
    # rt_k documents only level 1; do not invent levels 2-5.
    return snapshot(symbol, row, source_time, levels=1, volume_unit='share', received_at=received_at)
