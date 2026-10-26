"""Hosted signal monitoring. The parent handles authenticated market I/O and durable delivery."""
import contextlib
import importlib.util
import json
from datetime import datetime, timedelta
from pathlib import Path
import signal
import sys
from threading import Event as StopEvent

if __name__ == '__main__':
    sys.path.insert(0, sys.argv[1])
from quant_sdk import Bar, Fees, HubClient, Instrument, RunConfig, Strategy, TradingCalendar
from quant_sdk.live import LiveRunner
from strategy_entrypoint import resolve_strategy


class BridgeClient(HubClient):
    def __init__(self):
        self.sequence = 0

    def call(self, kind, **value):
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
        # Catch-up updates state without notifying about historical signals.
        if value['time'] <= self.cutoff:
            return
        bars = self.runner.data.history(symbol, 60, 1) if self.runner else []
        price = value.get('trigger_price', bars[-1].close if bars else None)
        for event_type, side in signals:
            self.client.call('signal', signal={'id': value['id'] + ':' + event_type, 'type': event_type,
                'side': side, 'symbol': symbol, 'time': value['time'], 'reason': str(value.get('reason', '')),
                'price': price, 'chart_time': value.get('trigger_bar_time', getattr(self.event.payload, 'time', value['time']) if self.event else value['time'])})

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
    stop = StopEvent()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    spec = importlib.util.spec_from_file_location('saved_strategy', directory / 'strategy.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    strategy = resolve_strategy(module, Strategy)()
    client = BridgeClient()
    calendar = ExchangeCalendar(config.get('calendar'))

    def rules(symbol, metadata):
        values = dict(config['rules'])
        values['fees'] = Fees(**values['fees'])
        if metadata['kind'] == 'stock':
            values['multiplier'] = values['margin_rate'] = 1
        return Instrument(symbol, metadata['kind'], price_tick=metadata['priceTick'], **values)

    with client.stream([config['symbol']], calendar=calendar, rules=rules,
                       duration=config['duration'], stop_event=stop) as stream:
        output = SignalOutput(client, stream.cutoff, saved.get('targets') if saved else None, saved.get('risk_times') if saved else None)
        if saved:
            checkpoint = directory / 'sdk-checkpoint.json'
            checkpoint.write_text(json.dumps(saved['runner']))
            runner = LiveRunner.restore(strategy, checkpoint, output_dir=directory / 'runs', on_event=output)
            stream._contracts.update(runner.data._contracts)
        else:
            runner = LiveRunner(strategy, stream.instruments, mode='paper',
                config=RunConfig(initial_cash=config['initial_cash'], start=stream.cutoff, checkpoint_interval=60),
                params={**config['parameters'], 'symbol':config['symbol'], 'duration':config['duration'], 'execution_model':'actual_contract'},
                output_dir=directory / 'runs', on_event=output)
        output.runner = runner
        checkpoint = runner.checkpoint
        preparing = True

        def persist():
            if preparing:
                runner._checkpoint_at = runner.data.now
                return runner.directory / 'checkpoint.json'
            # Bound diagnostics; keep order/signal identity counters and active trading state intact.
            runner.curve[:] = runner.curve[-1000:]
            runner.logs[:] = runner.logs[-500:]
            for name in ('events.jsonl', 'outputs.jsonl'):
                path = runner.directory / name
                if path.exists() and path.stat().st_size > 16 * 1024 * 1024:
                    path.write_text('')
            result = checkpoint()
            client.call('checkpoint', checkpoint={'runner':json.loads(result.read_text()), 'targets':output.targets, 'risk_times':output.risk_times})
            return result
        runner.checkpoint = persist
        runner.stop_event = stop
        start = (saved['runner']['now'] if saved else stream.cutoff) - config['warmup_days'] * 86400
        # Mapping initialization needs a trading instant even when the lookback lands on a holiday.
        try:
            calendar.trading_day(start, futures=stream.instruments[0].kind != 'stock')
        except ValueError:
            day = calendar._next(datetime.fromtimestamp(start, calendar.timezone).date())
            start = datetime.combine(day, datetime.min.time(), calendar.timezone).timestamp()
        if start < stream.cutoff:
            history = client.snapshot([config['symbol']], start=start, end=stream.cutoff,
                                      duration=config['duration'], calendar=calendar, rules=rules)
            runner.data._instruments.update({item.symbol: item for item in history.instruments})
            for event in history.events:
                if stop.is_set():
                    return
                if saved and event.available_at <= runner.data.now:
                    continue
                output.event = event
                runner.process(event, warmup=not saved)
        stream._contracts.update(runner.data._contracts)
        preparing = False
        runner._deliver()
        output.flush_overlay(config['symbol'])
        runner.checkpoint()
        client.call('ready')
        runner.start()
        for event in stream:
            if stop.is_set():
                break
            output.event = event
            runner.process(event)
            output.flush_overlay(config['symbol'])
        runner.checkpoint()
        runner.journal.close()


if __name__ == '__main__':
    # User print output is never interpreted as host commands.
    with contextlib.redirect_stdout(sys.stderr):
        main()
