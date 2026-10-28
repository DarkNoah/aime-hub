"""Shared causal event loop. Strategies store recoverable state in ctx.state."""
from dataclasses import asdict
from collections import OrderedDict
from hashlib import sha256
import inspect
import json
from pathlib import Path
import platform
from threading import Event as StopEvent
from typing import Callable
from uuid import uuid4

from .data import DataView
from .execution import Lot, Order, PaperBroker
from .metrics import summarize
from .models import Bar, Event, Fees, Instrument, Quote, Roll, RunConfig
from .risk import RiskLevels, accept, publish
from .state_codec import encode_state, decode_state
from .factors import snapshot_factors


class Strategy:
    def on_start(self, ctx): pass
    def on_ready(self, ctx): pass
    def on_bar(self, ctx, bar): pass
    def on_quote(self, ctx, quote): pass
    def on_roll(self, ctx, event, previous_contract): pass
    def on_order(self, ctx, order): pass
    def on_fill(self, ctx, fill): pass
    def on_stop(self, ctx, reason): pass


def _write(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    temporary.replace(path)


class Execution:
    def __init__(self, context):
        self._ctx = context

    def target_position(self, symbol: str, quantity: int, *, reason: str = '') -> str:
        ctx = self._ctx
        if ctx.warming_up or not ctx.event_id:
            raise ValueError('Orders are only allowed inside active event callbacks')
        ctx._runner.broker.validate_target(symbol, quantity)
        if ctx._runner.broker.points:
            quantity = (quantity > 0) - (quantity < 0)
        signal_id = ctx.emit('target_position', symbol=symbol, target=quantity, reason=reason)
        if ctx.mode == 'monitor':
            return signal_id
        return ctx._runner.broker.target_position(symbol, quantity, now=ctx.now, signal_id=signal_id, reason=reason)

    def cancel(self, order_id: str) -> None:
        self._ctx._runner.broker.cancel(order_id)


class Context:
    def __init__(self, runner, params: dict):
        self._runner = runner
        self.params = json.loads(json.dumps(params, allow_nan=False))
        self.state: dict = {}
        self.data = runner.data
        self.orders = Execution(self)
        self.event_id = ''
        self.trading_day = ''
        self.warming_up = True

    @property
    def now(self): return self.data.now
    @property
    def mode(self): return self._runner.mode
    @property
    def account(self): return self._runner.broker.account()

    def position(self, symbol: str) -> int:
        return self._runner.broker.position(symbol)

    def emit(self, kind: str, **payload) -> str:
        if self.warming_up or not self.event_id:
            raise ValueError('Signals cannot be emitted during warm-up')
        if {'id', 'event_id', 'time', 'trading_day', 'kind'}.intersection(payload):
            raise ValueError('Reserved signal fields')
        canonical = json.dumps([self._runner.source_hash, type(self._runner.strategy).__qualname__,
                                self._runner.manifest['params'], self.event_id, kind, payload], sort_keys=True, allow_nan=False)
        identity = sha256(canonical.encode()).hexdigest()
        if identity not in self._runner.signal_ids:
            signal = {'id': identity, 'event_id': self.event_id, 'time': self.now,
                      'trading_day': self.trading_day, 'kind': kind, **payload}
            self._runner.signal_ids.add(identity)
            self._runner.signals.append(signal)
            self._runner._output('signal', signal)
        return identity

    def log(self, message: str, **fields) -> None:
        self._runner.logs.append({'time': self.now, 'message': message, **fields})

    def set_risk_levels(self, symbol: str, *, stop_loss=None, take_profit=None, entry_id=None) -> None:
        """Publish a full TP/SL snapshot at the current calculation time."""
        publish(self, RiskLevels(symbol, stop_loss, take_profit, entry_id))


class Runner:
    def __init__(self, strategy: Strategy, instruments, *, config: RunConfig | None = None,
                 params: dict | None = None, mode: str = 'backtest', output_dir: str | Path = '.quant-runs',
                 on_event: Callable[[dict], None] | None = None, run_id: str | None = None):
        if mode not in ('backtest', 'paper', 'monitor'):
            raise ValueError('Unsupported execution mode')
        self.strategy, self.config, self.mode = strategy, config or RunConfig(), mode
        if self.config.pnl_mode == 'points' and mode != 'backtest':
            raise ValueError('Point accounting is only supported in historical backtests')
        self.data = DataView(instruments, self.config.history_limit)
        self.run_id = run_id or uuid4().hex
        self.directory = Path(output_dir) / self.run_id
        self.directory.mkdir(parents=True, exist_ok=False)
        self.signals, self.curve, self.logs = [], [], []
        self.signal_ids: set[str] = set()
        self.risk_levels: list[dict] = []
        self.seen = OrderedDict()
        self.output_events: list[dict] = []
        self.on_event = on_event
        self.stop_event = StopEvent()
        self.status, self.message = 'running', ''
        self.started = self.ready = self.finished = False
        self.benchmark_start = None
        self.benchmark_price = None
        self._checkpoint_at = float('-inf')
        self.broker = PaperBroker(self.data, self.config, self._notify,
                                  lambda **payload: self.context.emit('risk_exit', **payload))
        self.context = Context(self, params or {})
        self.source = self._source()
        self.source_hash = sha256(self.source.encode()).hexdigest()
        self.runtime_hash = sha256(b''.join(path.read_bytes() for path in sorted(Path(__file__).parent.glob('*.py')))).hexdigest()
        (self.directory / 'strategy.py').write_text(self.source, encoding='utf-8')
        self.manifest = {'schema_version': 1, 'run_id': self.run_id, 'mode': mode,
                         'strategy_class': type(strategy).__qualname__, 'source_hash': self.source_hash,
                         'sdk_version': '0.1.0', 'python_version': platform.python_version(),
                         'runtime_hash': self.runtime_hash,
                         'config': asdict(self.config), 'params': json.loads(json.dumps(self.context.params)),
                         'instruments': [asdict(i) for i in self.data._instruments.values()],
                         'fill_model': 'next_bar_open_with_slippage_and_bar_volume_cap',
                         'risk_model': {
                             'activation': 'latest_calculation_available_at_or_before_execution_bar_open',
                             'trigger': 'gap_open_then_ohlc; stop_loss_first_if_both_intrabar',
                             'fill': 'trigger_market_with_adverse_slippage_and_tick_rounding',
                             'priority': 'pending_risk_and_gap_exits; strategy_open_orders; intrabar_risk',
                             'constraints': 'shared_bar_volume_budget_and_T_plus_one; triggered_exit_remains_pending',
                             'intrabar_time': 'exit_time_is_bar_end; exit_bar_time_is_candle_anchor_not_exact_tick',
                         },
                         'settlement_model': 'previous_trading_day_last_observed_close',
                         'end_policy': 'mark_open_positions; cancel_pending_orders'}
        factors = snapshot_factors(self.directory)
        if factors:
            self.manifest['factor_versions'] = factors
        if self.broker.points:
            self.manifest.update(pnl_unit='points', position_model='fixed_one_unit_per_direction',
                                 fill_model='next_bar_open_with_slippage; no_cash_margin_volume_or_T_plus_one_constraints')
            self.manifest['risk_model']['constraints'] = 'fixed_one_unit; no_volume_or_T_plus_one_constraints'
        _write(self.directory / 'manifest.json', self.manifest)
        self.journal = (self.directory / 'events.jsonl').open('a', encoding='utf-8')
        _write(self.directory / 'status.json', {'status': self.status})

    def _source(self) -> str:
        try:
            source_file = inspect.getsourcefile(type(self.strategy))
            return Path(source_file).read_text(encoding='utf-8') if source_file else inspect.getsource(type(self.strategy))
        except (OSError, TypeError):
            raise ValueError('Strategy source must be available for reproducibility') from None

    def start(self) -> None:
        if not self.started:
            self.started = True
            self.strategy.on_start(self.context)

    def cancel(self) -> None:
        self.stop_event.set()

    def _output(self, kind: str, payload: dict) -> None:
        identity = sha256(json.dumps([self.source_hash, self.context.event_id, kind, payload],
                                    sort_keys=True, allow_nan=False).encode()).hexdigest()
        self.output_events.append({'id': identity, 'type': kind, 'run_id': self.run_id, 'payload': payload})

    def _deliver(self) -> None:
        if not self.output_events:
            return
        with (self.directory / 'outputs.jsonl').open('a', encoding='utf-8') as stream:
            while self.output_events:
                output = self.output_events[0]
                stream.write(json.dumps(output, ensure_ascii=False, allow_nan=False) + '\n')
                stream.flush()
                if self.on_event:
                    self.on_event(output)
                self.output_events.pop(0)

    def _notify(self, kind: str, payload: dict) -> None:
        self._output(kind, payload)
        if kind == 'order':
            accept(self.context, self.strategy.on_order(self.context, payload))
        else:
            accept(self.context, self.strategy.on_fill(self.context, payload))

    def process(self, event: Event, *, warmup: bool = False) -> bool:
        if self.finished:
            raise RuntimeError('Run is already closed')
        if self.stop_event.is_set():
            return False
        if self.config.end is not None and event.available_at > self.config.end:
            return False
        self.start()
        self._deliver()
        raw = event.to_dict()
        digest = sha256(json.dumps(raw, sort_keys=True, allow_nan=False).encode()).hexdigest()
        if event.id in self.seen:
            if self.seen[event.id] != digest:
                raise ValueError('Event identity reused with different contents')
            return False
        if event.available_at < self.data.now:
            raise ValueError('Out-of-order event: recover/reorder at the data adapter')
        self.seen[event.id] = digest
        while len(self.seen) > self.config.dedup_limit:
            self.seen.popitem(last=False)
        self.journal.write(json.dumps(raw, ensure_ascii=False, allow_nan=False) + '\n')
        self.journal.flush()
        correction, previous = self.data._apply(event)
        if isinstance(event.payload, Bar) and event.payload.trading_day < self.broker.trading_day:
            correction = True
        ctx = self.context
        ctx.event_id, ctx.trading_day = event.id, event.payload.trading_day
        ctx.warming_up = warmup or (self.config.start is not None and event.available_at < self.config.start)
        if correction:
            ctx.log('Historical correction applied without retriggering strategy', event_id=event.id)
            self._maybe_checkpoint()
            return False
        value = event.payload
        if ctx.warming_up:
            self._maybe_checkpoint()
            return False
        if not self.ready:
            self.ready = True
            self.strategy.on_ready(ctx)
        if isinstance(value, Bar) and value.is_final:
            self.broker.begin_day(ctx.trading_day)
        if isinstance(value, Bar) and value.is_final:
            if self.mode != 'monitor':
                self.broker.on_bar(value)
            if value.symbol == self.config.benchmark_symbol:
                self.benchmark_price = value.close
                if self.benchmark_start is None and value.open > 0:
                    self.benchmark_start = value.open
        if self.data.subscribed(value):
            if isinstance(value, Bar):
                accept(ctx, self.strategy.on_bar(ctx, value))
            elif isinstance(value, Quote):
                accept(ctx, self.strategy.on_quote(ctx, value))
            else:
                accept(ctx, self.strategy.on_roll(ctx, value, previous))
        if isinstance(value, Bar) and value.is_final:
            account = self.broker.account()
            self.curve.append({'time': ctx.now, 'trading_day': ctx.trading_day, **account,
                               'benchmark_equity': (self.benchmark_price - self.benchmark_start if self.broker.points else
                                                    self.config.initial_cash * self.benchmark_price / self.benchmark_start)
                               if self.benchmark_start and self.benchmark_price is not None else None})
        # Checkpoint precedes delivery. Consumers deduplicate by stable event/signal ID.
        self._maybe_checkpoint()
        self._deliver()
        return True

    def _maybe_checkpoint(self):
        if self.mode != 'backtest' and (self.output_events or self.data.now - self._checkpoint_at >= self.config.checkpoint_interval):
            self.checkpoint()

    def checkpoint(self) -> Path:
        path = self.directory / 'checkpoint.json'
        self._checkpoint_at = self.data.now
        self.manifest['instruments'] = [asdict(i) for i in self.data._instruments.values()]
        _write(path, {'schema_version': 1, 'manifest': self.manifest,
                      'now': self.data.now, 'state_encoding': 1, 'state': encode_state(self.context.state),
                      'trading_day': self.context.trading_day, 'event_id': self.context.event_id,
                      'ready': self.ready, 'seen': self.seen, 'signals': self.signals,
                      'risk_levels': self.risk_levels,
                      'curve': self.curve, 'logs': self.logs,
                      'pending_outputs': self.output_events,
                      'benchmark_start': self.benchmark_start, 'benchmark_price': self.benchmark_price,
                      'bars': [asdict(b) for rows in self.data._bars.values() for b in rows.values()],
                      'quotes': [asdict(q) for q in self.data._quotes.values()],
                      'contracts': self.data._contracts, 'roll_times': self.data._roll_times,
                      'subscriptions': list(self.data._subscriptions),
                      'broker': {'cash': self.broker.cash, 'lots': [asdict(l) for l in self.broker.lots],
                                 'orders': [asdict(o) for o in self.broker.orders], 'fills': self.broker.fills,
                                 'trades': self.broker.trades, 'marks': self.broker.marks,
                                 'fill_sequence': self.broker.fill_sequence, 'trade_sequence': self.broker.trade_sequence,
                                 'trading_day': self.broker.trading_day}})
        return path

    def performance(self):
        return summarize(self.curve, self.broker.trades, self.config)

    def finish(self, status: str = 'succeeded', message: str = '') -> dict:
        if self.finished:
            return self.result
        self.status, self.message = status, message
        self.context.event_id = ''
        try:
            self.broker.cancel_all(status)
            self.strategy.on_stop(self.context, message or status)
        except Exception as error:
            self.status, self.message = 'failed', f'{type(error).__name__}: {error}'
        self.checkpoint()
        try:
            self._deliver()
        except Exception as error:
            self.status, self.message = 'failed', f'Output delivery failed: {type(error).__name__}'
        self.result = {'schema_version': 1, 'run_id': self.run_id, 'status': self.status, 'message': self.message,
                       'pnl_unit': 'points' if self.broker.points else 'currency',
                       **self.performance(),
                       'equity_curve': self.curve, 'trades': self.broker.trades,
                       'orders': [asdict(o) for o in self.broker.orders], 'fills': self.broker.fills,
                       'signals': self.signals, 'risk_levels': self.risk_levels,
                       'logs': self.logs, 'account': self.broker.account(),
                       'artifacts': str(self.directory.resolve())}
        _write(self.directory / 'result.json', self.result)
        _write(self.directory / 'manifest.json', self.manifest)
        _write(self.directory / 'status.json', {'status': self.status, 'message': self.message})
        self.journal.close()
        self.finished = True
        return self.result

    @classmethod
    def restore(cls, strategy, checkpoint: str | Path, *, output_dir: str | Path = '.quant-runs', on_event=None):
        value = json.loads(Path(checkpoint).read_text(encoding='utf-8'))
        if value['schema_version'] != 1:
            raise ValueError('Unsupported checkpoint')
        if value.get('state_encoding') not in (None, 1):
            raise ValueError('Unsupported checkpoint state encoding')
        manifest = value['manifest']
        instruments = [Instrument(**{**item, 'fees': Fees(**item['fees'])}) for item in manifest['instruments']]
        runner = cls(strategy, instruments, config=RunConfig(**manifest['config']), params=manifest['params'],
                     mode=manifest['mode'], output_dir=output_dir, on_event=on_event)
        if (runner.source_hash != manifest['source_hash'] or runner.runtime_hash != manifest['runtime_hash']
                or type(strategy).__qualname__ != manifest['strategy_class']):
            runner.finish('failed', 'Strategy source differs from checkpoint')
            raise ValueError('Strategy source differs from checkpoint')
        runner.manifest['resumed_from'] = str(Path(checkpoint).resolve())
        _write(runner.directory / 'manifest.json', runner.manifest)
        # Recreate transient attributes (parameters, caches, context references)
        # on the new strategy instance before hydrating durable trading state.
        # Initialization runs with an empty event/warm-up context, so it cannot
        # emit signals or place orders against the restored portfolio.
        try:
            runner.start()
        except BaseException:
            runner.journal.close()
            raise
        for raw in value['bars']:
            bar = Bar(**raw)
            runner.data._apply(Event(f'restore:{bar.symbol}:{bar.duration}:{bar.time}', bar.end_time, bar))
        runner.data._quotes = {q['symbol']: Quote(**q) for q in value['quotes']}
        runner.data._contracts = value['contracts']
        runner.data._roll_times = value.get('roll_times', {})
        runner.data._subscriptions = {tuple(s) for s in value['subscriptions']}
        runner.data.now = value['now']
        state = decode_state(value['state']) if value.get('state_encoding') == 1 else value['state']
        runner.context.state.clear()
        runner.context.state.update(state)
        runner.context.trading_day = value['trading_day']
        runner.context.event_id = value['event_id']
        runner.context.warming_up = False
        runner.started, runner.ready = True, value['ready']
        runner.seen, runner.signals = OrderedDict(value['seen']), value['signals']
        runner.signal_ids = {s['id'] for s in runner.signals}
        runner.risk_levels = value.get('risk_levels', [])
        for record in runner.risk_levels:
            runner.broker.protection.update(record)
        runner.curve, runner.logs = value['curve'], value['logs']
        runner.output_events = value.get('pending_outputs', [])
        runner.benchmark_start, runner.benchmark_price = value['benchmark_start'], value['benchmark_price']
        broker = value['broker']
        runner.broker.cash, runner.broker.marks = broker['cash'], broker['marks']
        runner.broker.lots = [Lot(**lot) for lot in broker['lots']]
        runner.broker.orders = [Order(**order) for order in broker['orders']]
        runner.broker.fills, runner.broker.trades = broker['fills'], broker['trades']
        runner.broker.fill_sequence = broker.get('fill_sequence', len(broker['fills']))
        runner.broker.trade_sequence = broker.get('trade_sequence', len(broker['trades']))
        runner.broker.trading_day = broker['trading_day']
        return runner
