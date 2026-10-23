"""Incremental real-time execution and deterministic stream replay."""
from dataclasses import replace
from .data import Dataset
from .models import RunConfig
from .runtime import Runner, _write


class LiveRunner(Runner):
    def __init__(self, strategy, instruments, *, mode='monitor', **kwargs):
        if mode not in ('monitor', 'paper'):
            raise ValueError('Live mode must be monitor or paper')
        super().__init__(strategy, instruments, mode=mode, **kwargs)

    def run(self, events, *, warmup=()):
        try:
            # A polling source shares cancellation so it can wake even without new quotes.
            if hasattr(events, 'stop_event'):
                if self.stop_event.is_set():
                    events.stop_event.set()
                self.stop_event = events.stop_event
            self.start()
            for event in warmup:
                if self.stop_event.is_set():
                    return self.finish('cancelled', '用户中止了操作')
                self.process(event, warmup=True)
            for event in events:
                if self.stop_event.is_set():
                    return self.finish('cancelled', '用户中止了操作')
                if self.config.end is not None and event.available_at > self.config.end:
                    break
                self.process(event)
            return self.finish('cancelled', '用户中止了操作') if self.stop_event.is_set() else self.finish()
        except KeyboardInterrupt:
            return self.finish('cancelled', '用户中止了操作')
        except Exception as error:
            return self.finish('failed', f'{type(error).__name__}: {error}')
        finally:
            close = getattr(events, 'close', None)
            if close:
                close()


def run(strategy, events, *, instruments=None, warmup=None, mode='monitor', config=None,
        params=None, output_dir='.quant-runs', on_event=None):
    """Convenience entry point for a HubStream or a caller-provided event iterable."""
    items = {i.symbol: i for i in (instruments if instruments is not None else events.instruments)}
    if isinstance(warmup, Dataset):
        items.update({i.symbol: i for i in warmup.instruments})
    config = config or RunConfig()
    if config.start is None and hasattr(events, 'cutoff'):
        config = replace(config, start=events.cutoff)
    runner = LiveRunner(strategy, items.values(), config=config, params=params, mode=mode,
                        output_dir=output_dir, on_event=on_event)
    if hasattr(events, 'calendar'):
        runner.manifest['data_source'] = {'kind': 'vibe-quant-live', 'calendar': events.calendar.to_dict(),
                                         'duration': events.duration, 'symbols': events.symbols,
                                         'cutoff': events.cutoff, 'engine': events.session.get('engine')}
    if isinstance(warmup, Dataset):
        warmup.save(runner.directory / 'warmup.json')
        runner.manifest['warmup_hash'] = warmup.fingerprint
    _write(runner.directory / 'manifest.json', runner.manifest)
    return runner.run(events, warmup=warmup.events if isinstance(warmup, Dataset) else (warmup or ()))
