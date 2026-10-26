"""Hosted signal monitoring. The parent handles authenticated market I/O and durable delivery."""
import contextlib
import importlib.util
import json
from datetime import datetime, timedelta
from pathlib import Path
import signal
import sys
from time import monotonic
from threading import Event as StopEvent, Lock

if __name__ == '__main__':
    sys.path.insert(0, sys.argv[1])
from quant_sdk import Bar, Fees, HubClient, Instrument, RunConfig, Strategy, TradingCalendar
from quant_sdk.runtime import Runner
from strategy_entrypoint import resolve_strategy
from signal_history import BufferedEvents, MonitorHistory, history_events


class BridgeClient(HubClient):
    def __init__(self, simulated_symbol=None):
        self.sequence = 0
        self.lock = Lock()
        self.simulated_symbol = simulated_symbol

    def instrument(self, symbol):
        metadata = super().instrument(symbol)
        # Adapt only this explicitly simulated monitor's catalog, as frozen
        # continuous-price backtests do. The shared market catalog is untouched.
        return {**metadata, 'kind': 'future'} if symbol == self.simulated_symbol else metadata

    def call(self, kind, **value):
        with self.lock:
            return self._call(kind, **value)

    def _call(self, kind, **value):
        self.sequence += 1
        sys.__stdout__.write(json.dumps({'id': self.sequence, 'kind': kind, **value}, ensure_ascii=False, allow_nan=False) + '\n')
        sys.__stdout__.flush()
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError('Monitor host disconnected')
        response = json.loads(line)
        if response.get('id') != self.sequence or response.get('error'):
            raise RuntimeError(response.get('error', 'Invalid monitor response'))
        return response.get('value')

    def request(self, path, *, method='GET', params=None, body=None):
        if path == '/history' and params:
            params = {**params, 'limit': 5000}
        if path == '/history' and params and params.get('symbol') == self.simulated_symbol:
            params = {**params, 'execution_model': 'continuous_price'}
        return self.call('market', path=path, method=method, params=params, body=body)


class ExchangeCalendar(TradingCalendar):
    def __init__(self, override=None):
        super().__init__(override or {})
        self.override = override is not None

    def _ensure(self, day):
        if day not in self.days and not self.override:
            from chinese_calendar import is_holiday
            self.days[day] = day.weekday() < 5 and not is_holiday(day)

    def _next(self, day):
        for _ in range(32):
            self._ensure(day)
            if day not in self.days:
                raise ValueError(f'Missing exchange calendar date: {day}')
            if self.days[day]:
                return day
            day += timedelta(days=1)
        raise ValueError('No trading date in calendar window')

    def trading_day(self, timestamp, *, futures=False):
        day = datetime.fromtimestamp(timestamp, self.timezone).date()
        self._ensure(day)
        self._ensure(day + timedelta(days=1))
        return super().trading_day(timestamp, futures=futures)


class SignalOutput:
    def __init__(self, client, cutoff, targets=None, risk_times=None):
        self.client, self.cutoff = client, cutoff
        self.targets = targets or {}
        self.risk_times = risk_times or {}
        self.runner = None
        self.event = None
        self.overlay_key = None
        self.dirty = True
        self.history = None

    def __call__(self, event):
        if event['type'] in ('signal', 'risk_levels'):
            self.dirty = True
        if event['type'] == 'risk_levels':
            value = event['payload']
            self.risk_times[value['id']] = getattr(self.event.payload, 'time', value['time']) if self.event and self.event.available_at == value['time'] else value['time']
        if event['type'] != 'signal':
            return
        value = event['payload']
        symbol, kind = value.get('symbol'), value['kind']
        if not symbol:
            return
        previous = self.targets.get(symbol, 0)
        signals = []
        if kind == 'target_position':
            target = value['target']
            if previous and (previous * target <= 0 or abs(target) < abs(previous)):
                signals.append(('exit', 'long' if previous > 0 else 'short'))
            if target and (previous * target <= 0 or abs(target) > abs(previous)):
                signals.append(('entry', 'long' if target > 0 else 'short'))
            self.targets[symbol] = target
        elif kind == 'risk_exit':
            signals.append(('exit', 'long' if previous > 0 else 'short' if previous < 0 else 'unknown'))
            self.targets[symbol] = self.runner.broker.position(symbol) if self.runner else 0
        elif kind in ('entry', 'exit'):
            signals.append((kind, value.get('side') if value.get('side') in ('long', 'short') else 'unknown'))
        bars = self.runner.data.history(symbol, 60, 1) if self.runner else []
        price = value.get('trigger_price', bars[-1].close if bars else None)
        for event_type, side in signals:
            record = {'id': value['id'] + ':' + event_type, 'type': event_type,
                'side': side, 'symbol': symbol, 'time': value['time'], 'reason': str(value.get('reason', '')),
                'price': price, 'chart_time': value.get('trigger_bar_time', getattr(self.event.payload, 'time', value['time']) if self.event else value['time'])}
            if self.history:
                self.history.signal(record)
            # Historical records are persisted, but never replay old notifications.
            if value['time'] > self.cutoff:
                self.client.call('signal', signal=record)

    def flush_overlay(self, chart_symbol):
        if not self.dirty and (self.overlay_key == '[]' or not self.event or not isinstance(self.event.payload, Bar)):
            return
        self.dirty = False
        runner = self.runner
        active = {lot.signal_id for lot in runner.broker.lots}
        active.update(order.signal_id for order in runner.broker.orders if order.status == 'pending' and order.target)
        active.difference_update(order.risk_entry_signal_id for order in runner.broker.orders if order.risk_entry_signal_id)
        targets = {value['id']: value.get('target', 0) for value in runner.signals if value['kind'] == 'target_position'}
        latest = {}
        for record in runner.risk_levels:
            latest[(record['symbol'], record['entry_signal_id'])] = record
        levels = []
        for (symbol, entry), record in latest.items():
            if entry not in active or targets.get(entry, 0) * self.targets.get(symbol, 0) <= 0:
                continue
            offset = 0 if symbol == chart_symbol else None
            # Main-series overlays use only a same-minute observed basis for the current contract.
            if offset is None and runner.data._contracts.get(chart_symbol) == symbol:
                actual = {bar.time: bar.close for bar in runner.data.history(symbol, 60, 10)}
                for bar in reversed(runner.data.history(chart_symbol, 60, 10)):
                    if bar.time in actual and bar.time >= runner.data._roll_times.get(chart_symbol, 0):
                        offset = bar.close - actual[bar.time]
                        break
            levels.append({key: record[key] for key in ('id', 'symbol', 'entry_signal_id', 'time', 'stop_loss', 'take_profit')} | {
                'chart_time': self.risk_times.get(record['id'], record['time']),
                'chart_stop_loss': None if offset is None or record['stop_loss'] is None else record['stop_loss'] + offset,
                'chart_take_profit': None if offset is None or record['take_profit'] is None else record['take_profit'] + offset,
            })
        key = json.dumps(levels, sort_keys=True)
        if key != self.overlay_key:
            self.client.call('overlay', overlay={'updated_at': runner.data.now, 'levels': levels})
            self.overlay_key = key


def main():
    directory = Path(sys.argv[2])
    config = json.loads((directory / 'config.json').read_text())
    saved = json.loads((directory / 'checkpoint.json').read_text()) if (directory / 'checkpoint.json').exists() else None
    # Rebuild legacy monitor history once to add the protection paths used by
    # the existing trade chart. Stable trade/signal IDs replace the same records.
    if saved and saved.get('history_version') != 2:
        saved = None
    execution_model = config.get('execution_model', 'actual_contract')
    simulated = execution_model == 'continuous_price'
    if simulated and not config['symbol'].startswith('KQ.m@'):
        raise ValueError('主连价格模拟仅适用于主连标的')
    if saved and saved['runner']['manifest']['params'].get('execution_model', 'actual_contract') != execution_model:
        raise ValueError('历史计算口径已变更，请移除后重新添加策略提示')
    stop = StopEvent()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    spec = importlib.util.spec_from_file_location('saved_strategy', directory / 'strategy.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    strategy = resolve_strategy(module, Strategy)()
    client = BridgeClient(config['symbol'] if simulated else None)
    calendar = ExchangeCalendar(config.get('calendar'))

    def rules(symbol, metadata):
        values = dict(config['rules'])
        values['fees'] = Fees(**values['fees'])
        if metadata['kind'] == 'stock':
            values['multiplier'] = values['margin_rate'] = 1
        # This monitor alone treats the main-price series as a synthetic future.
        kind = 'future' if simulated and symbol == config['symbol'] else metadata['kind']
        return Instrument(symbol, kind, price_tick=metadata['priceTick'], **values)

    with client.stream([config['symbol']], calendar=calendar, rules=rules,
                       duration=config['duration'], stop_event=stop) as stream:
        with BufferedEvents(stream, directory / 'live-events.jsonl') as live:
            bounds = client.request('/history/range', params={'symbol': config['symbol'], 'duration': config['duration']})
            first = bounds['start'] if bounds.get('start') is not None else stream.cutoff
            output = SignalOutput(client, stream.cutoff, saved.get('targets') if saved else None, saved.get('risk_times') if saved else None)
            if saved:
                checkpoint = directory / 'sdk-checkpoint.json'
                checkpoint.write_text(json.dumps(saved['runner']))
                runner = Runner.restore(strategy, checkpoint, output_dir=directory / 'runs', on_event=output)
            else:
                runner = Runner(strategy, stream.instruments, mode='backtest' if simulated else 'paper',
                    config=RunConfig(initial_cash=config['initial_cash'], start=first, checkpoint_interval=60, benchmark_symbol=config['symbol']),
                    params={**config['parameters'], 'symbol':config['symbol'], 'duration':config['duration'], 'execution_model':execution_model},
                    output_dir=directory / 'runs', on_event=output)
            output.runner = runner
            checkpoint = runner.checkpoint
            history = MonitorHistory(client, runner, first, saved.get('history') if saved else None)
            output.history = history
            preparing = True
            checkpoint_at = monotonic()

            def persist():
                nonlocal checkpoint_at
                if preparing and monotonic() - checkpoint_at < 10:
                    runner._checkpoint_at = runner.data.now
                    return runner.directory / 'checkpoint.json'
                history.flush(force=True)
                retained = {value['id'] for value in runner.risk_levels}
                output.risk_times = {key: value for key, value in output.risk_times.items() if key in retained}
                for name in ('events.jsonl', 'outputs.jsonl'):
                    path = runner.directory / name
                    if path.exists() and path.stat().st_size > 16 * 1024 * 1024:
                        path.write_text('')
                result = checkpoint()
                client.call('checkpoint', checkpoint={'runner': json.loads(result.read_text()),
                    'targets': output.targets, 'risk_times': output.risk_times,
                    'history_version': 2, 'history': history.state})
                checkpoint_at = monotonic()
                return result
            runner.checkpoint = persist
            # Continuous-price history uses backtest semantics for strategy guards,
            # while this hosted runner still checkpoints and consumes new live bars.
            def maybe_checkpoint():
                if runner.output_events or runner.data.now - runner._checkpoint_at >= runner.config.checkpoint_interval:
                    persist()
            runner._maybe_checkpoint = maybe_checkpoint
            runner.stop_event = stop
            start = max(first, saved['runner']['now'] - 86400) if saved else first
            if start < stream.cutoff:
                for event in history_events(client, runner, config['symbol'], config['duration'],
                                            start, stream.cutoff, calendar, rules):
                    live.check()
                    if stop.is_set():
                        return
                    if saved and event.available_at < saved['runner']['now']:
                        continue
                    output.event = event
                    runner.process(event)
                    history.flush()
            history.replaying = False
            preparing = False
            runner._deliver()
            output.flush_overlay(config['symbol'])
            runner.checkpoint()
            client.call('ready')
            runner.start()
            for event in live:
                if stop.is_set():
                    break
                output.event = event
                runner.process(event)
                output.flush_overlay(config['symbol'])
                history.flush(force=bool(history.pending))
            runner.checkpoint()
            runner.journal.close()


if __name__ == '__main__':
    # User print output is never interpreted as host commands.
    with contextlib.redirect_stdout(sys.stderr):
        main()
