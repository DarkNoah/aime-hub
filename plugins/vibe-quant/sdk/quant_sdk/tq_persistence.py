"""Version-pinned TqSim checkpoint adapter; never patches installed dependency files.

TqSdk has no public save/restore API. Keep the small serialization boundary here,
validate the exact SDK version, and let its own SimTrade perform all accounting.
"""
from copy import deepcopy
from collections.abc import Mapping
from importlib.metadata import version
from math import isfinite
from tqsdk import TqSim
from tqsdk.channel import TqChan
from tqsdk.tradeable.sim.trade_future import SimTrade

SDK_VERSION = '3.10.2'
FIELDS = ('_account', '_positions', '_orders', '_trades', '_quotes', '_max_datetime')


def pack(value):
    if isinstance(value, Mapping):
        return {k: pack(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [pack(v) for v in value]
    if isinstance(value, float) and not isfinite(value):
        return {'__tq_float__': str(value)}
    return value


def unpack(value):
    if isinstance(value, Mapping):
        if set(value) == {'__tq_float__'}:
            return float(value['__tq_float__'])
        return {k: unpack(v) for k, v in value.items()}
    if isinstance(value, list):
        return [unpack(v) for v in value]
    return value


class RestoredTrade(SimTrade):
    def init_snapshot(self):
        result = super().init_snapshot()
        data = result['trade'][self._account_key]
        data['positions'] = deepcopy(self._positions)
        data['trades'] = {t['trade_id']: deepcopy(t) for t in self._trades}
        orders = deepcopy(getattr(self, 'saved_orders', {}))
        pending = {key for values in self._orders.values() for key in values}
        filled = set(getattr(self, 'settled_order_ids', ())) | {t['order_id'] for t in self._trades}
        # An ALIVE API placeholder may not yet have reached SimTrade. Omit it
        # so the strategy adapter can replay that exact unprocessed identity.
        orders = {key: value for key, value in orders.items()
                  if key in pending or key in filled or value['status'] == 'FINISHED'}
        for values in self._orders.values():
            orders.update(deepcopy(values))
        for order_id in filled:
            if order_id in orders:
                orders[order_id].update(status='FINISHED', volume_left=0)
        data['orders'] = orders
        return result


class DurableTqSim(TqSim):
    def __init__(self, init_balance, account_id, saved=None):
        if version('tqsdk') != SDK_VERSION:
            raise RuntimeError(f'TqSim 状态适配器需要 tqsdk=={SDK_VERSION}；升级后须先验证状态迁移')
        super().__init__(init_balance=init_balance, account_id=account_id)
        self._sim_trade = RestoredTrade(self._account_key, account_id, float(init_balance),
            get_trade_timestamp=self._get_trade_timestamp, is_in_trading_time=self._is_in_trading_time)
        if saved:
            if saved.get('sdk') != SDK_VERSION or saved.get('account_id') != account_id:
                raise ValueError('TqSim 检查点版本或账户不匹配')
            value = unpack(saved['state'])
            for key in FIELDS:
                setattr(self._sim_trade, key, value['trade'][key])
            self._sim_trade.saved_orders = value['orders']
            self.trade_log = value['log']
            self._sim_trade.settled_order_ids = {t['order_id'] for day in self.trade_log.values() for t in day['trades']}
            self._current_datetime, self._trading_day_end = value['clock'], value['day_end']
        self._restored_symbols = set(self._sim_trade._positions) | set(self._sim_trade._orders)

    async def _handle_recv_data(self, packet, channel):
        # Restored positions also need quote tasks, even when no new order arrives.
        for symbol in self._restored_symbols:
            if symbol not in self._quote_tasks:
                quote_chan, order_chan = TqChan(self._api), TqChan(self._api)
                self._quote_tasks[symbol] = {'quote_chan': quote_chan, 'order_chan': order_chan,
                    'task': self._api.create_task(self._quote_handler(symbol, quote_chan, order_chan))}
        self._restored_symbols.clear()
        await super()._handle_recv_data(packet, channel)

    def _handle_stat_report(self):
        # API shutdown/history handoff must not force an intraday settlement,
        # cancel GFD orders, or turn today's SHFE positions into yesterday's.
        # Genuine exchange-day transitions still call BaseSim._settle normally.
        pass

    def snapshot(self, api):
        return {'sdk': SDK_VERSION, 'account_id': self._account_id, 'state': pack({
            'trade': {key: getattr(self._sim_trade, key) for key in FIELDS},
            'orders': {key: dict(order) for key, order in api.get_order().items()},
            'log': deepcopy(self.trade_log), 'clock': self._current_datetime, 'day_end': self._trading_day_end})}

    def report_log(self):
        logs = deepcopy(self.trade_log)
        day = self._trading_day_end[:10]
        if day != '1990-01-01':
            logs[day] = {'account': deepcopy(self._sim_trade._account),
                         'trades': deepcopy(self._sim_trade._trades),
                         'positions': deepcopy(self._sim_trade._positions)}
        return logs
