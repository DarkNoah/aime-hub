from dataclasses import replace

from .data import Dataset
from .models import RunConfig
from .runtime import Runner, _write


def run(strategy, data: Dataset, *, params=None, config=None, output_dir='.quant-runs', on_event=None, stop_event=None):
    """Every invocation writes its source, input snapshot, config and result."""
    config = config or RunConfig()
    if data.metadata.get('execution_model') == 'points' and config.pnl_mode != 'points':
        raise ValueError('Point snapshots require point accounting')
    if config.start is None and data.events:
        config = replace(config, start=data.events[0].available_at)
    runner = Runner(strategy, data.instruments, params=params, config=config,
                    output_dir=output_dir, on_event=on_event)
    if stop_event is not None:
        runner.stop_event = stop_event
    try:
        data.save(runner.directory / 'dataset.json')
        runner.manifest['data_snapshot_hash'] = data.fingerprint
        for key in ('execution_model', 'simulated_execution_symbol', 'execution_policy', 'mapping_policy', 'data_policy'):
            if key in data.metadata:
                runner.manifest[key] = data.metadata[key]
        _write(runner.directory / 'manifest.json', runner.manifest)
        runner.start()
        for event in data.events:
            if runner.stop_event.is_set():
                return runner.finish('cancelled', '用户中止了操作')
            if config.end is not None and event.available_at > config.end:
                break
            runner.process(event)
        return runner.finish()
    except KeyboardInterrupt:
        return runner.finish('cancelled', '用户中止了操作')
    except Exception as error:
        return runner.finish('failed', f'{type(error).__name__}: {error}')
