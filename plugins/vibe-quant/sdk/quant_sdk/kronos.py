"""Optional, offline Kronos sampling. Probabilities are model frequencies, not win rates.

Install a pinned bundle with worker/setup_kronos.py. No model downloads occur in
strategies. Importing quant_sdk never imports torch or loads model weights.
"""
from collections import OrderedDict
from contextlib import redirect_stdout
from dataclasses import asdict, dataclass
from datetime import datetime, time, timedelta
from functools import lru_cache
from hashlib import sha256
import importlib
import json
from math import isfinite
import os
from pathlib import Path
import sys
from threading import RLock
from zoneinfo import ZoneInfo

from .factors import Factor

_LOCK = RLock()
_RESULTS = OrderedDict()


class KronosCancelled(KeyboardInterrupt):
    """The runner treats interrupted inference as cancellation, never a signal."""


def _check_stop(stop_event):
    if stop_event is not None and stop_event.is_set():
        raise KronosCancelled('用户中止了操作')


@dataclass(frozen=True)
class KronosForecast:
    bullish_probability: float
    bearish_probability: float
    neutral_probability: float
    expected_return: float
    return_p10: float
    return_p50: float
    return_p90: float
    mean_close_path: tuple
    sample_count: int
    horizon: int
    as_of: float
    target_time: float
    model_fingerprint: str
    seed: int

    def to_dict(self):
        return asdict(self)


def _quantile(values, q):
    position = (len(values) - 1) * q
    left = int(position)
    right = min(left + 1, len(values) - 1)
    return values[left] + (values[right] - values[left]) * (position - left)


def summarize_paths(close_paths, reference, *, flat_return=0.0):
    """P(C[t+H]/C[t]-1 > flat_return), and its bearish/neutral complements.

    Every row must be one independently sampled path. Never pass the averaged
    output of predictor.predict(sample_count=N) as though it were N samples.
    """
    if not isfinite(reference) or reference <= 0:
        raise ValueError('Kronos reference close must be positive')
    if not isfinite(flat_return) or flat_return < 0:
        raise ValueError('flat_return must be finite and nonnegative')
    paths = tuple(tuple(float(v) for v in row) for row in close_paths)
    if len(paths) < 2 or not paths[0] or any(len(row) != len(paths[0]) for row in paths):
        raise ValueError('Kronos needs at least two equal-length sample paths')
    if any(not isfinite(v) or v <= 0 for row in paths for v in row):
        raise ValueError('Kronos generated a nonfinite or nonpositive close')
    returns = sorted(row[-1] / reference - 1 for row in paths)
    up = sum(value > flat_return for value in returns)
    down = sum(value < -flat_return for value in returns)
    count = len(paths)
    return dict(bullish_probability=up / count, bearish_probability=down / count,
                neutral_probability=(count - up - down) / count,
                expected_return=sum(returns) / count,
                return_p10=_quantile(returns, .1), return_p50=_quantile(returns, .5),
                return_p90=_quantile(returns, .9),
                mean_close_path=tuple(sum(row[i] for row in paths) / count for i in range(len(paths[0]))))


def _future_times(bar, horizon):
    # IM/IF/IH/IC share known daytime sessions. Stay within this trading day:
    # tomorrow's exchange holidays must never be guessed from future prices.
    symbol = bar.symbol.removeprefix('KQ.m@')
    if not symbol.startswith(('CFFEX.IM', 'CFFEX.IF', 'CFFEX.IH', 'CFFEX.IC')) or bar.duration >= 86400:
        raise ValueError('Provide future_times (bar OPEN epochs) from the exchange calendar for this market')
    zone = ZoneInfo('Asia/Shanghai')
    current = datetime.fromtimestamp(bar.end_time, zone)
    day = current.date()
    sessions = [(datetime.combine(day, time(9, 30), zone), datetime.combine(day, time(11, 30), zone)),
                (datetime.combine(day, time(13), zone), datetime.combine(day, time(15), zone))]
    result = []
    for start, end in sessions:
        current = max(current, start)
        while current + timedelta(seconds=bar.duration) <= end and len(result) < horizon:
            result.append(current.timestamp())
            current += timedelta(seconds=bar.duration)
    return tuple(result) if len(result) == horizon else None


@lru_cache(maxsize=2)
def _bundle(root):
    directory = Path(root).resolve()
    manifest_path = directory / 'manifest.json'
    if not manifest_path.is_file():
        raise RuntimeError('Kronos is not installed; run worker/setup_kronos.py and set QUANT_KRONOS_ROOT')
    manifest = json.loads(manifest_path.read_text())
    # A bundle is immutable for this process. Verify downloaded code and weights
    # once, then identify every forecast by their actual content hashes.
    files = manifest['files']
    required = {'source/model/__init__.py', 'source/model/kronos.py', 'source/model/module.py',
                'model/config.json', 'model/model.safetensors',
                'tokenizer/config.json', 'tokenizer/model.safetensors'}
    if not required.issubset(files):
        raise ValueError('Incomplete Kronos bundle manifest')
    for name, expected in files.items():
        path = (directory / name).resolve()
        if directory not in path.parents or sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f'Kronos bundle hash mismatch: {name}')
    fingerprint = sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    return directory, manifest, fingerprint


@lru_cache(maxsize=2)
def _predictor(root, device):
    directory, manifest, fingerprint = _bundle(root)
    try:
        import torch
        import pandas
        import einops
        import huggingface_hub
    except ImportError as error:
        raise RuntimeError('Install worker/requirements-kronos.txt in the strategy Python environment') from error
    source = directory / 'source'
    existing = sys.modules.get('model')
    if existing and Path(getattr(existing, '__file__', '')).resolve() != source / 'model/__init__.py':
        raise RuntimeError('Kronos upstream uses package name model; use a separate process for a different bundle')
    sys.path.insert(0, str(source))
    try:
        module = importlib.import_module('model')
    finally:
        sys.path.remove(str(source))
    # Upstream's local loader prints status lines. stdout belongs to the host's
    # JSON worker protocol, so model diagnostics must go to stderr.
    with redirect_stdout(sys.stderr):
        tokenizer = module.KronosTokenizer.from_pretrained(str(directory / 'tokenizer'), local_files_only=True)
        model = module.Kronos.from_pretrained(str(directory / 'model'), local_files_only=True)
    tokenizer.eval()
    model.eval()
    predictor = module.KronosPredictor(model, tokenizer, device=device, max_context=manifest['max_context'])
    return predictor, fingerprint


def _sample_paths(root, device, bars, future_times, samples, temperature, top_p, seed, stop_event):
    import torch
    import pandas as pd

    predictor, _ = _predictor(root, device)
    frame = pd.DataFrame([{key: getattr(bar, key) for key in ('open', 'high', 'low', 'close', 'volume')}
                          for bar in bars])
    # Missing turnover is explicitly zero, never synthesized as volume * price.
    frame['amount'] = [bar.amount if bar.amount is not None else 0.0 for bar in bars]
    timestamp = lambda values: pd.Series(pd.to_datetime(values, unit='s', utc=True).tz_convert('Asia/Shanghai').tz_localize(None))
    x_times = timestamp([bar.time for bar in bars])
    y_times = timestamp(future_times)
    devices = [torch.device(device).index or 0] if device.startswith('cuda') else []
    mps_state = torch.mps.get_rng_state() if device == 'mps' else None
    # Hooks run inside upstream generation without editing dependency sources.
    hook = predictor.model.embedding.register_forward_pre_hook(lambda *_: _check_stop(stop_event))
    try:
        with torch.random.fork_rng(devices=devices), torch.inference_mode():
            torch.random.default_generator.manual_seed(seed)
            if devices:
                with torch.cuda.device(device):
                    torch.cuda.manual_seed(seed)
            if mps_state is not None:
                torch.mps.manual_seed(seed)
            paths = predictor.predict_batch(
                df_list=[frame] * samples, x_timestamp_list=[x_times] * samples,
                y_timestamp_list=[y_times] * samples, pred_len=len(future_times),
                T=temperature, top_p=top_p, sample_count=1, verbose=False)
            _check_stop(stop_event)
            return [path['close'].tolist() for path in paths]
    finally:
        hook.remove()
        if mps_state is not None:
            torch.mps.set_rng_state(mps_state)


def kronos_forecast(bars, *, lookback=128, horizon=6, samples=32, seed=0,
                    temperature=1.0, top_p=.9, flat_return=0.0,
                    future_times=None, bundle=None, device='cpu', stop_event=None):
    """Forecast from closed bars only; return None for warm-up/session-end gaps.

    future_times are known future bar OPEN epochs, not future market observations.
    Auto scheduling supports same-day CFFEX equity-index futures; other markets
    must supply their exchange schedule. CPU is the reproducible default.
    """
    _check_stop(stop_event)
    for name, value, low, high in [('lookback', lookback, 2, 500), ('horizon', horizon, 1, 128),
                                   ('samples', samples, 2, 256), ('seed', seed, 0, 2**32-1)]:
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f'Invalid Kronos {name}: expected integer {low}..{high}')
    if not isfinite(temperature) or temperature <= 0 or not 0 < top_p <= 1:
        raise ValueError('Invalid Kronos sampling temperature/top_p')
    if not isfinite(flat_return) or flat_return < 0:
        raise ValueError('flat_return must be finite and nonnegative')
    if device not in ('cpu', 'mps') and not device.startswith('cuda'):
        raise ValueError('Kronos supports cpu, mps or cuda devices')
    closed = tuple(bar for bar in bars if bar.is_final)
    if len(closed) < lookback:
        return None
    window = closed[-lookback:]
    if any(bar.symbol != window[0].symbol or bar.duration != window[0].duration for bar in window):
        raise ValueError('Kronos requires one symbol and duration')
    if any(a.end_time > b.time or a.time >= b.time for a, b in zip(window, window[1:])):
        raise ValueError('Kronos bars must be chronological and non-overlapping')
    if any(min(bar.open, bar.high, bar.low, bar.close) <= 0 for bar in window):
        raise ValueError('Kronos prices must be positive')
    times = _future_times(window[-1], horizon) if future_times is None else tuple(future_times)
    if times is None:
        return None
    if (len(times) != horizon or any(not isfinite(t) for t in times) or times[0] < window[-1].end_time
            or any(b - a < window[-1].duration for a, b in zip(times, times[1:]))):
        raise ValueError('future_times must contain horizon non-overlapping future bar OPEN epochs')
    root = str(Path(bundle or os.environ.get('QUANT_KRONOS_ROOT',
                    Path(sys.prefix) / 'share/quant-kronos')).resolve())
    with _LOCK:
        _check_stop(stop_event)
        _, manifest, fingerprint = _bundle(root)
        if lookback > manifest['max_context'] or horizon > manifest['max_context']:
            raise ValueError('Kronos window exceeds the installed model context')
        settings = [fingerprint, device, horizon, samples, seed, temperature, top_p, flat_return, times]
        history = [[b.symbol, b.duration, b.time, b.end_time, b.open, b.high, b.low, b.close, b.volume, b.amount]
                   for b in window]
        digest = sha256(json.dumps([settings, history], allow_nan=False).encode()).hexdigest()
        if digest in _RESULTS:
            _RESULTS.move_to_end(digest)
            return _RESULTS[digest]
        sample_seed = int(digest[:8], 16)
        try:
            paths = _sample_paths(root, device, window, times, samples, temperature, top_p, sample_seed, stop_event)
        except ImportError as error:
            raise RuntimeError('Install worker/requirements-kronos.txt in the strategy Python environment') from error
        if len(paths) != samples or any(len(path) != horizon for path in paths):
            raise ValueError('Kronos returned an unexpected sample shape')
        result = KronosForecast(**summarize_paths(paths, window[-1].close, flat_return=flat_return),
                                sample_count=samples, horizon=horizon, as_of=window[-1].end_time,
                                target_time=times[-1] + window[-1].duration,
                                model_fingerprint=fingerprint, seed=sample_seed)
        _RESULTS[digest] = result
        if len(_RESULTS) > 128:
            _RESULTS.popitem(last=False)
        return result


class KronosFactor(Factor):
    """Scalar adapter: bullish/bearish/neutral probability or expected_return.

    Construct lazily; weights stay outside checkpoint state. Fixed bundle,
    parameters, input window and device produce the same sampling seed.
    """
    def lookback(self, params):
        return params.get('lookback', 128)

    def forecast(self, ctx, symbol, duration=60, **params):
        """Structured forecast using only the strategy clock's visible history."""
        count = self.lookback(params)
        if type(count) is not int or not 2 <= count <= 500:
            raise ValueError('Kronos lookback must be an integer from 2 to 500')
        if ctx.data.instrument(symbol).kind not in ('future', 'continuous'):
            raise ValueError('KronosFactor currently supports futures')
        if ctx.data.history_limit < count:
            raise ValueError('Strategy history_limit is smaller than Kronos lookback')
        stop = getattr(getattr(ctx, '_runner', None), 'stop_event', None)
        return kronos_forecast(ctx.data.history(symbol, duration, count), stop_event=stop, **params)

    def compute(self, bars, params):
        options = dict(params)
        metric = options.pop('metric', 'bullish_probability')
        if metric not in ('bullish_probability', 'bearish_probability', 'neutral_probability',
                          'expected_return', 'return_p10', 'return_p50', 'return_p90'):
            raise ValueError('Unsupported Kronos factor metric')
        result = kronos_forecast(bars, **options)
        return getattr(result, metric) if result else None
