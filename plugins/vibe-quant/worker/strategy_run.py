"""Run a pinned, administrator-owned script using the plugin's Python environment."""
import importlib.util
import json
from pathlib import Path
import signal
import sys
import threading

sys.path.insert(0, sys.argv[1])
from quant_sdk import Dataset, RunConfig, Strategy, backtest
from strategy_entrypoint import resolve_strategy


def main():
    directory = Path(sys.argv[2])
    config = json.loads((directory / 'config.json').read_text(encoding='utf-8'))
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    spec = importlib.util.spec_from_file_location('saved_strategy', directory / 'strategy.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # Old run directories may still contain this retired setting; it no longer selects a class.
    config.pop('entrypoint', None)
    strategy = resolve_strategy(module, Strategy)
    params = config.pop('parameters')
    result = backtest.run(strategy(), Dataset.load(directory / 'dataset.json'), params=params,
                          config=RunConfig(**config), output_dir=directory / 'artifacts', stop_event=stop)
    (directory / 'result.json').write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')


if __name__ == '__main__':
    main()
