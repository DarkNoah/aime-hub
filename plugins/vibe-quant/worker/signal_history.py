"""Paged full-history replay and compact incremental monitor performance."""
from heapq import merge
from time import monotonic
from quant_sdk import Bar
from quant_sdk.models import Roll
from quant_sdk.hub import DataError, convert_bar, event_for, three_minute
from quant_sdk.metrics import summarize
from quant_sdk.point_metrics import summarize_points


def history_events(client, runner, symbol, duration, start, end, calendar, rules):
    """Merge paged price streams without retaining the complete dataset in RAM."""
    item = client.rules(symbol, rules)
    runner.data._instruments[symbol] = item
    requests = {(symbol, duration): (start, end)}
    rolls = []
    if item.tradable:
        requests[(symbol, 60)] = (start, end)
    if item.kind == 'continuous':
        mappings = list(client.contracts(symbol, start, end))
        if not mappings or mappings[0]['time'] > start:
            raise DataError(f'No observed contract mapping at start for {symbol}')
        for mapping in mappings:
            contract = mapping['underlying']
            runner.data._instruments[contract] = client.rules(contract, rules)
            if runner.data._instruments[contract].kind != 'future':
                raise DataError('Main contracts must resolve to actual futures')
            lower = max(start, mapping['time'])
            # Retain exit bars across a rollover, including positions in the old contract.
            prior = requests.get((contract, 60), (lower, end))
            requests[(contract, 60)] = (min(prior[0], lower), end)
            rolls.append(event_for(Roll(symbol, contract, lower, calendar.trading_day(lower, futures=True))))
    def bars(name, period, bounds):
        instrument = runner.data._instruments[name]
        group, bucket, count = {}, None, 0
        for raw in client.history(name, 60 if period == 180 else period, *bounds):
            bar = convert_bar(raw, instrument, calendar)
            if bar.end_time > end:
                continue
            count += 1
            if period == 180:
                key = int(bar.time // 180)
                if key != bucket:
                    if value := three_minute(group.values()):
                        yield event_for(value)
                    group, bucket = {}, key
                group[bar.time] = bar
            else:
                yield event_for(bar)
        if period == 180 and (value := three_minute(group.values())):
            yield event_for(value)
        if not count and period == 60 and instrument.tradable and bounds[1] - bounds[0] >= 60:
            raise DataError(f'Missing execution history for {name}')
    def order(event):
        return (event.available_at, 0 if isinstance(event.payload, Roll) else
                2 if runner.data._instruments[event.payload.symbol].kind == 'continuous' else 1)
    streams = [iter(rolls), *(bars(name, period, bounds) for (name, period), bounds in sorted(requests.items()))]
    observed, execution = dict(runner.data._contracts), {}
    for event in merge(*streams, key=order):
        value = event.payload
        if isinstance(value, Roll):
            observed[value.symbol] = value.contract
        elif runner.data._instruments[value.symbol].kind == 'continuous':
            if execution.get(observed.get(value.symbol)) != value.end_time:
                raise DataError(f'Missing actual-contract execution bar for {value.symbol} at {value.end_time}')
        elif value.duration == 60:
            execution[value.symbol] = value.end_time
        yield event


class MonitorHistory:
    def __init__(self, client, runner, start, saved=None):
        self.client, self.runner = client, runner
        self.state = saved or {'start': start, 'daily': {}, 'peak': 0 if runner.broker.points else runner.config.initial_cash,
                              'drawdown': 0, 'count': 0, 'wins': 0, 'positive': 0, 'negative': 0}
        self.state.setdefault('risk_levels', {})
        self.pending = []
        self.last_flush = monotonic()
        self.replaying = True

    def signal(self, value):
        self.pending.append({'kind': 'signal', 'id': value['id'], 'time': value['time'], 'payload': value})

    def observe(self):
        runner, state = self.runner, self.state
        # Keep the complete causal path for each open entry even when the runner
        # compacts old snapshots. Closed trades carry their own immutable copy.
        risk_snapshots = state['risk_levels']
        for record in runner.risk_levels:
            risk_snapshots[record['id']] = dict(record)
        for point in runner.curve:
            state['daily'][point['trading_day']] = point
            state['peak'] = max(state['peak'], point['equity'])
            drawdown = state['peak'] - point['equity']
            state['drawdown'] = max(state['drawdown'], drawdown if runner.broker.points else drawdown / state['peak'])
        runner.curve.clear()
        for trade in runner.broker.trades:
            state['count'] += 1
            state['wins'] += trade['net_pnl'] > 0
            state['positive'] += max(trade['net_pnl'], 0)
            state['negative'] -= min(trade['net_pnl'], 0)
            levels = self.levels(trade['symbol'], trade['entry_signal_id'], trade.get('risk_level_id'))
            payload = {**trade, 'risk_levels': levels} if levels else trade
            self.pending.append({'kind': 'trade', 'id': trade['id'], 'time': trade['exit_time'], 'payload': payload})
        runner.broker.trades.clear()
        runner.broker.fills.clear()
        active = {lot.signal_id for lot in runner.broker.lots}
        active.update(order.signal_id for order in runner.broker.orders if order.status == 'pending')
        active.update(order.risk_entry_signal_id for order in runner.broker.orders
                      if order.status == 'pending' and order.risk_entry_signal_id)
        state['risk_levels'] = {key: record for key, record in risk_snapshots.items()
                                if record['entry_signal_id'] in active}
        # Active entry identities and causal protection levels survive compaction.
        runner.signals[:] = [value for value in runner.signals[:-200] if value['id'] in active] + runner.signals[-200:]
        runner.signal_ids = {value['id'] for value in runner.signals}
        # target_position returns an order ID in simulated execution. Keep its
        # signal mapping for exactly as long as the retained entry signal, even
        # after closing; strategies may still publish a final protection update.
        # Otherwise the same valid reference works in a full backtest but fails
        # after monitor compaction or checkpoint recovery.
        retained = active | runner.signal_ids
        runner.broker.orders[:] = [order for order in runner.broker.orders
                                   if order.status == 'pending' or order.signal_id in retained]
        risk = {}
        boundary = runner.data.now - 86400
        for value in runner.risk_levels:
            if value['entry_signal_id'] in active:
                key = (value['symbol'], value['entry_signal_id'])
                rows = risk.setdefault(key, [])
                if value['time'] < boundary:
                    rows[:] = [value]
                else:
                    rows.append(value)
        runner.risk_levels[:] = [value for rows in risk.values() for value in rows]
        runner.broker.protection.history = {}
        for value in runner.risk_levels:
            runner.broker.protection.update(value)
        runner.logs[:] = runner.logs[-100:]
        if runner.data._contracts:
            # Retired execution contracts no longer need thousands of cached candles.
            keep = set(runner.data._contracts) | set(runner.data._contracts.values())
            keep.update(symbol for symbol, _ in runner.data._subscriptions)
            keep.update(lot.symbol for lot in runner.broker.lots)
            keep.update(order.symbol for order in runner.broker.orders)
            for key in list(runner.data._bars):
                if key[0] not in keep and runner.data._instruments[key[0]].kind == 'future':
                    del runner.data._bars[key]


    def levels(self, symbol, entry, triggered=None):
        records = sorted((record for record in self.state['risk_levels'].values()
                          if record['symbol'] == symbol and record['entry_signal_id'] == entry),
                         key=lambda record: record['time'])
        # Repeated calculations with unchanged prices do not add a chart step.
        # Preserve the exact triggering ID so pending exits freeze the right level.
        return [record for index, record in enumerate(records)
                if index in (0, len(records) - 1) or record['id'] == triggered
                or any(record[key] != records[index - 1][key] for key in ('stop_loss', 'take_profit'))]

    def summary(self):
        runner, state = self.runner, self.state
        daily = [value for _, value in sorted(state['daily'].items())]
        points = runner.broker.points
        result = summarize_points(daily, []) if points else summarize(daily, [], runner.config)
        result['metrics'].update(trade_count=state['count'],
            win_rate=state['wins'] / state['count'] if state['count'] else None,
            profit_factor=state['positive'] / state['negative'] if state['negative'] else None)
        if points:
            realized = state['positive'] - state['negative']
            result['metrics'].update(realized_points=realized,
                unrealized_points=result['metrics']['total_points'] - realized,
                average_trade_points=realized / state['count'] if state['count'] else None,
                max_drawdown_points=state['drawdown'])
        else:
            result['metrics']['max_drawdown'] = state['drawdown']
            annual = result['metrics']['annual_return']
            result['metrics']['calmar'] = annual / state['drawdown'] if annual is not None and state['drawdown'] else None
        opened = []
        for index, lot in enumerate(runner.broker.lots):
            opened.append({'id': f'open:{lot.signal_id}:{lot.entry_time}:{index}', 'status': 'open',
                'symbol': lot.symbol, 'side': 'long' if lot.quantity > 0 else 'short',
                'quantity': abs(lot.quantity), 'entry_time': lot.entry_time, 'entry_price': lot.entry_price,
                'entry_signal_id': lot.signal_id, 'fees': lot.entry_fee, 'exit_time': None,
                'exit_price': None, 'gross_pnl': None, 'net_pnl': None, 'exit_signal_id': None,
                'observed_until': runner.data.now,
                'risk_levels': self.levels(lot.symbol, lot.signal_id)})
        return {key: result[key] for key in ('metrics', 'monthly_returns', 'yearly_returns')} | {
            'start': state['start'], 'through': runner.data.now, 'initial_cash': runner.config.initial_cash,
            'replaying': self.replaying, 'equity_curve': daily, 'open_trades': opened,
            'pnl_unit': 'points' if points else 'currency',
            'execution_model': runner.context.params.get('execution_model', 'actual_contract')}

    def flush(self, force=False):
        self.observe()
        if not force and len(self.pending) < 500 and monotonic() - self.last_flush < 1:
            return False
        while self.pending:
            self.client.call('history', batch={'records': self.pending[:500]})
            del self.pending[:500]
        self.client.call('history', batch={'records': [], 'summary': self.summary()})
        self.last_flush = monotonic()
        return True


class BufferedEvents:
    """Keep the live session alive during a long replay; spool events instead of dropping ticks."""
    def __init__(self, stream, path):
        from threading import Condition, Thread
        self.stream, self.path = stream, path
        self.condition, self.pending, self.error = Condition(), 0, None
        self.thread = Thread(target=self._collect, daemon=True)

    def __enter__(self):
        self.path.touch()
        self.reader = self.path.open()
        self.thread.start()
        return self

    def _collect(self):
        import json
        try:
            with self.path.open('a') as output:
                for event in self.stream:
                    with self.condition:
                        output.write(json.dumps(event.to_dict(), allow_nan=False) + '\n')
                        output.flush()
                        self.pending += 1
                        self.condition.notify_all()
        except Exception as error:
            with self.condition:
                self.error = error
                self.condition.notify_all()

    def check(self):
        if self.error:
            raise self.error

    def __iter__(self):
        import json
        from quant_sdk.models import Event
        while not self.stream.stop_event.is_set():
            with self.condition:
                self.check()
                if not self.pending:
                    self.condition.wait(1)
                    continue
                line = self.reader.readline()
                self.pending -= 1
                # Once drained, recycle the spool so a long-running monitor stays bounded.
                if not self.pending:
                    self.path.write_text('')
                    self.reader.seek(0)
            yield Event.from_dict(json.loads(line))

    def __exit__(self, *_):
        self.stream.stop_event.set()
        self.thread.join(timeout=2)
        self.reader.close()
