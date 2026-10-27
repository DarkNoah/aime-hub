"""Restore the Strategy context and reporting ledger around a restored native account."""
from copy import deepcopy
import json
from pathlib import Path
from .runtime import Runner
from .execution import Lot
from .tq_broker import TargetOrder


def snapshot_runner(runner, sequence):
    checkpoint = json.loads(runner.checkpoint().read_text())
    return {'runner': checkpoint, 'sequence': sequence,
            'children': {key: parent.id for key, (_, parent) in runner.broker.children.items()},
            'seen_trades': [list(key) for key in runner.broker.seen_trades]}


def restore_runner(strategy, saved, output_dir, on_event):
    checkpoint = deepcopy(saved['runner'])
    # Runner's stock restore reconstructs the callback context. The native broker
    # is attached immediately afterwards and restores its richer target records.
    for order in checkpoint['broker']['orders']:
        order.pop('native_orders', None)
    path = Path(output_dir).parent / 'restore-runner.json'
    path.write_text(json.dumps(checkpoint, allow_nan=False))
    return Runner.restore(strategy, path, output_dir=output_dir, on_event=on_event)


def restore_broker(runner, saved, api):
    broker = runner.broker
    data = saved['runner']['broker']
    broker.lots = [Lot(**value) for value in data['lots']]
    broker.orders = [TargetOrder(**value) for value in data['orders']]
    for key in ('fills', 'trades', 'marks', 'fill_sequence', 'trade_sequence', 'trading_day'):
        setattr(broker, key, data[key])
    broker.seen_trades = {tuple(value) for value in saved['seen_trades']}
    for record in runner.risk_levels:
        broker.protection.update(record)
    parents = {order.id: order for order in broker.orders}
    available = api.get_order()
    for native_id, parent_id in saved['children'].items():
        parent = parents[parent_id]
        detail = next(item for item in parent.native_orders if item['id'] == native_id)
        if native_id in available:
            native = available[native_id]
        elif parent.status != 'pending':
            continue  # Cancelled queued intent never reached the native account.
        else:
            # A checkpoint can include an intent still queued in TqApi. Re-submit
            # only the missing native identity, never a new unrelated order.
            native = api.insert_order(broker.symbol, direction=detail['direction'], offset=detail['offset'],
                volume=detail['quantity'], limit_price=detail['limit_price'], order_id=native_id)
        broker.children[native_id] = (native, parent)
        if parent.status != 'pending' and native.status == 'ALIVE':
            api.cancel_order(native)  # Re-send a cancellation that may have been queued at shutdown.
