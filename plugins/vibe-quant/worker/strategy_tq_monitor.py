"""Historical TqBacktest -> durable TqSim -> live TqApi, using one strategy/account ledger."""
import contextlib
from datetime import datetime
from importlib.metadata import version
import importlib.util
import json
from pathlib import Path
import signal
import sys
import threading
import time

if __name__ == '__main__':
    sys.path.insert(0, sys.argv[1])
from quant_sdk import Strategy
from quant_sdk.tq_backtest import prepare, TZ, quote_time
with contextlib.redirect_stdout(sys.stderr):
    from quant_sdk.tq_persistence import DurableTqSim
from strategy_entrypoint import resolve_strategy
from strategy_monitor import BridgeClient
from tq_monitor_history import NativeHistory, NativeSignalOutput


def main():
    directory = Path(sys.argv[2])
    config = json.loads((directory / 'config.json').read_text())
    saved = json.loads((directory / 'checkpoint.json').read_text()) if (directory / 'checkpoint.json').exists() else None
    if saved and saved.get('native_schema') != 1:
        raise ValueError('TqSim 检查点格式不兼容，请重新创建此策略任务')
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    client = BridgeClient()
    credentials = client.call('credentials')
    # Protocol stdout must never contain SDK announcements or user print output.
    with contextlib.redirect_stdout(sys.stderr):
        from tqsdk import TqApi, TqAuth, TqBacktest, BacktestFinished
        spec = importlib.util.spec_from_file_location('saved_strategy', directory / 'strategy.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        strategy_class = resolve_strategy(module, Strategy)
        if saved and saved.get('outbox'):
            client.call('commit', checkpoint=saved)
        # Initial replay spans the configured historical range. A resumed live
        # session keeps its native portfolio; downtime only warms indicators and
        # does not fabricate fills against unobserved historical quotes.
        phase = saved['phase'] if saved else 'history'
        history = NativeHistory(client, config, saved)
        cutoff = time.time()
        while not stop.is_set():
            historical = phase == 'history'
            sim = DurableTqSim(config['initial_cash'], config['monitor_id'], (saved or {}).get('native'))
            start = saved['context']['runner']['now'] if saved else config['history_start']
            kwargs = {'backtest': TqBacktest(start_dt=datetime.fromtimestamp(start, TZ),
                        end_dt=datetime.fromtimestamp(cutoff, TZ))} if historical else {}
            api = None
            try:
                api = TqApi(sim, auth=TqAuth(credentials['tqUser'], credentials['tqPassword']),
                            web_gui=False, debug=False, disable_print=True, **kwargs)
                raw = {**config, '_live': not historical, 'start': start, 'end': cutoff if historical else time.time() + 3660 * 86400,
                       'annualization': 250, 'risk_free_rate': 0, 'benchmark_symbol': None,
                       'slippage_ticks': config.get('slippage_ticks', 0)}
                output = NativeSignalOutput(history, cutoff, (saved or {}).get('targets'), (saved or {}).get('risk_times'))
                runner, feed, consume = prepare(strategy_class(), api, sim, raw, output_dir=directory / 'runs',
                    stop_event=stop, sdk_version=version('tqsdk'), on_event=output,
                    restored=(saved or {}).get('context'), on_update=history.observe)
                history.runner, history.feed, history.sim, history.api, history.output = runner, feed, sim, api, output
                output.runner, output.history = runner, history
                history.phase = phase
                runner.start()
                feed.subscribe()
                if not historical:
                    # The historical handoff/native restore already contains all
                    # previous bars. Do not execute a backlog at today's price.
                    feed.discard_before = quote_time(runner.broker.quote) or runner.data.now
                    client.call('ready')
                    history.commit()
                consume()
                pulse = time.monotonic()
                while not stop.is_set():
                    feed.subscribe()
                    if api.wait_update(deadline=time.time() + .5):
                        consume()
                    if time.monotonic() - pulse > 10:
                        client.call('pulse')
                        pulse = time.monotonic()
                    if runner.journal.tell() > 16 * 1024 * 1024:
                        # History/trades/checkpoints are durable in ClickHouse.
                        runner.journal.seek(0)
                        runner.journal.truncate()
            except BacktestFinished:
                consume(final=True)
                history.phase = phase = 'live'
                history.commit()
                saved = history.checkpoint({'batch': {'records': []}})
            finally:
                if api is not None:
                    if stop.is_set() and history.runner is not None:
                        # Best effort on cancellation; the previous acknowledged
                        # outbox remains the recovery point if the parent is gone.
                        try: history.commit()
                        except Exception: pass
                    api.close()
                    if history.runner is not None and not history.runner.journal.closed:
                        history.runner.journal.close()
            if not historical:
                break
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Credentials are additionally redacted by the trusted parent process.
        print(f'TqSim 实时策略失败：{type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
