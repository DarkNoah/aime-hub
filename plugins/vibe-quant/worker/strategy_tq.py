"""One credential-scoped TqBacktest/TqSim process per queued historical run."""
from datetime import datetime
from importlib.metadata import version
import importlib.util
import json
from pathlib import Path
import signal
import sys
import threading
from zoneinfo import ZoneInfo

sys.path.insert(0, sys.argv[1])
from quant_sdk import Strategy
from quant_sdk.tq_backtest import run
from strategy_entrypoint import resolve_strategy


def main():
    directory = Path(sys.argv[2])
    config = json.loads((directory / 'config.json').read_text(encoding='utf-8'))
    credentials = json.load(sys.stdin)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    def redact(value):
        for secret in credentials.values():
            if secret:
                value = value.replace(secret, '[redacted]')
        return value
    api = None
    try:
        if stop.is_set():
            raise ValueError('用户中止了操作')
        from tqsdk import TqApi, TqAuth, TqSim, TqBacktest, BacktestFinished
        sim = TqSim(init_balance=config['initial_cash'])
        tz = ZoneInfo('Asia/Shanghai')
        api = TqApi(sim, auth=TqAuth(credentials['tqUser'], credentials['tqPassword']),
            backtest=TqBacktest(start_dt=datetime.fromtimestamp(config['start'], tz),
                                end_dt=datetime.fromtimestamp(config['end'], tz)),
            web_gui=False, debug=False, disable_print=True)
        spec = importlib.util.spec_from_file_location('saved_strategy', directory / 'strategy.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        strategy = resolve_strategy(module, Strategy)
        result = run(strategy(), api, sim, config, output_dir=directory / 'artifacts', stop_event=stop,
                     finished_exception=BacktestFinished, sdk_version=version('tqsdk'), redact=redact)
        (directory / 'result.json').write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    except Exception as error:
        # Provider authentication exceptions must never expose credentials in saved job messages.
        print(redact(f'天勤回测失败：{type(error).__name__}: {error}'), file=sys.stderr)
        return 1
    finally:
        if api is not None:
            api.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
