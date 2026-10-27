"""Causal chart replay batches. Checkpoints and notifications never touch live monitors."""
import contextlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys

if __name__ == '__main__':
    sys.path.insert(0, sys.argv[1])
from quant_sdk import RunConfig, Strategy
from quant_sdk.runtime import Runner
from strategy_entrypoint import resolve_strategy
from strategy_prepare import prepare
from strategy_monitor import SignalOutput
from signal_history import MonitorHistory


class Output:
    def __init__(self, overlay=None):
        self.overlay = overlay or {'updated_at': None, 'levels': []}

    def call(self, kind, **value):
        if kind == 'overlay':
            self.overlay = value['overlay']
        # Signals are collected by MonitorHistory, never published to the host.


def replay(directory):
    request = json.loads((directory / 'request.json').read_text())
    raw = json.loads((directory / 'market.json').read_text())
    config = raw['config']
    saved = json.loads((directory / 'checkpoint.json').read_text()) if (directory / 'checkpoint.json').exists() else None
    spec = importlib.util.spec_from_file_location('saved_replay_strategy', directory / 'strategy.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    strategy = resolve_strategy(module, Strategy)()
    dataset = prepare(raw)
    output = Output(saved.get('overlay') if saved else None)
    signals = SignalOutput(output, float('-inf'), saved.get('targets') if saved else None,
                           saved.get('risk_times') if saved else None)
    if saved:
        path = directory / 'restore.json'
        path.write_text(json.dumps(saved['runner']))
        runner = Runner.restore(strategy, path, output_dir=directory / 'runs', on_event=signals)
    else:
        runner = Runner(strategy, dataset.instruments,
                        mode='backtest' if config['execution_model'] in ('points', 'continuous_price') else 'paper',
                        config=RunConfig(start=config['start'], initial_cash=config['initial_cash'],
                                         pnl_mode='points' if config.get('execution_model') == 'points' else 'currency',
                                         point_cost=config.get('point_cost', 0), benchmark_symbol=config['symbol']),
                        params={**config['parameters'], 'symbol': config['symbol'], 'duration': config['duration'],
                                'execution_model': config['execution_model']},
                        output_dir=directory / 'runs', on_event=signals)
    try:
        # Batches persist atomically once; per-event paper checkpoints are unnecessary.
        runner._maybe_checkpoint = lambda: None
        runner.data._instruments.update({item.symbol: item for item in dataset.instruments})
        signals.runner = runner
        history = MonitorHistory(output, runner, config['start'], saved.get('history') if saved else None)
        signals.history = history
        through = saved['through'] if saved else float('-inf')
        events = iter(event for event in dataset.events if event.available_at > through)
        event = next(events, None)
        frames = []
        for cutoff in request['times']:
            while event is not None and event.available_at <= cutoff:
                signals.event = event
                runner.process(event)
                history.observe()
                event = next(events, None)
            signals.flush_overlay(config['symbol'])
            summary = history.summary()
            frame = {'time': cutoff, 'signals': [], 'trades': [], 'summary': summary,
                     'positions': summary['open_trades'], 'overlay': output.overlay}
            for record in history.pending:
                if record['kind'] == 'signal':
                    frame['signals'].append({**record['payload'], 'monitor_id': request['monitor_id']})
                elif record['kind'] == 'trade':
                    frame['trades'].append(record['payload'])
            history.pending.clear()
            # The next event can mutate lots and protection records; freeze each frame now.
            frames.append(json.loads(json.dumps(frame, allow_nan=False)))
        checkpoint = json.loads(runner.checkpoint().read_text())
        state = {'runner': checkpoint, 'through': request['times'][-1], 'history': history.state,
                 'targets': signals.targets, 'risk_times': signals.risk_times, 'overlay': output.overlay}
        (directory / 'checkpoint.next.json').write_text(json.dumps(state, ensure_ascii=False, allow_nan=False))
        (directory / 'result.json').write_text(json.dumps({'frames': frames, 'through': state['through']}, ensure_ascii=False, allow_nan=False))
    finally:
        runner.journal.close()
        shutil.rmtree(directory / 'runs', ignore_errors=True)


if __name__ == '__main__':
    with contextlib.redirect_stdout(sys.stderr):
        replay(Path(sys.argv[2]))
