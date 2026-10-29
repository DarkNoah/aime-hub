"""Causal, reusable Python factors. Published versions are frozen by the host."""
from hashlib import sha256
import inspect
import json
from math import isfinite
from pathlib import Path
import sys
import types
from uuid import UUID


class Factor:
    """Implement compute(bars, params), returning a finite number or None.

    Only finalized historical bars are passed, oldest first. Keep compute pure:
    the same history and parameters must always produce the same value.
    """
    def lookback(self, params):
        return 100

    def compute(self, bars, params):
        raise NotImplementedError

    def evaluate(self, bars, params=None):
        params = dict(params or {})
        count = self.lookback(params)
        if type(count) is not int or not 1 <= count <= 500:
            raise ValueError('因子 lookback 必须是 1 至 500 的整数')
        closed = tuple(bar for bar in bars if bar.is_final)
        if len(closed) < count:
            return None
        window = closed[-count:]
        if any(b.symbol != window[0].symbol or b.duration != window[0].duration for b in window):
            raise ValueError('因子窗口必须来自同一合约和周期')
        if any(a.end_time >= b.end_time for a, b in zip(window, window[1:])):
            raise ValueError('因子历史必须按收盘时间递增')
        value = self.compute(window, params)
        if value is None:
            return None
        if isinstance(value, (bool, str, bytes)):
            raise ValueError('因子必须返回数值或 None')
        value = float(value)
        if not isfinite(value):
            raise ValueError('因子返回了 NaN 或无穷值，请在数据不足时返回 None')
        return value

    def value(self, ctx, symbol, duration=86400, **params):
        """Read only the strategy clock's closed history; no provider/network access."""
        if ctx.data.instrument(symbol).kind not in ('future', 'continuous'):
            raise ValueError('因子暂时只支持期货')
        count = self.lookback(params)
        if type(count) is not int or not 1 <= count <= 500:
            raise ValueError('因子 lookback 必须是 1 至 500 的整数')
        if ctx.data.history_limit < count:
            raise ValueError('策略 history_limit 小于因子 lookback')
        return self.evaluate(ctx.data.history(symbol, duration, count), params)


def factor_from_source(source, name='custom_factor'):
    module = types.ModuleType(name)
    sys.modules[name] = module
    try:
        exec(compile(source, f'<{name}>', 'exec'), module.__dict__)
        candidates = {value for value in vars(module).values()
                      if inspect.isclass(value) and value is not Factor
                      and value.__module__ == name and issubclass(value, Factor)
                      and not inspect.isabstract(value)}
        leaves = [cls for cls in candidates
                  if not any(other is not cls and issubclass(other, cls) for other in candidates)]
        if len(leaves) != 1:
            raise ValueError('每个因子脚本须包含一个具体的 quant_sdk.Factor 子类')
        if leaves[0].compute is Factor.compute:
            raise ValueError('因子须实现 compute(self, bars, params)')
        return leaves[0]()
    except BaseException:
        sys.modules.pop(name, None)
        raise


class PublishedFactor(Factor):
    def __init__(self, factor, parameters, version_id):
        self.factor, self.parameters, self.version_id = factor, parameters, version_id

    def lookback(self, params):
        return self.factor.lookback({**self.parameters, **params})

    def compute(self, bars, params):
        return self.factor.compute(bars, {**self.parameters, **params})

    def evaluate_panel(self, histories, params=None):
        method = getattr(self.factor, 'evaluate_panel', None)
        if method is None:
            raise ValueError('该因子未实现横截面计算')
        return method(histories, {**self.parameters, **(params or {})})


def load_factor(version_id):
    """Use a literal published UUID: load_factor('...'). Host bundles it per run.

    For standalone SDK use, export factor-library.json beside your run command.
    Network lookup and mutable 'latest' references are intentionally unsupported.
    """
    if str(UUID(version_id)) != version_id:
        raise ValueError('请使用已发布因子的完整版本 ID')
    path = Path.cwd() / 'factor-library.json'
    if not path.is_file():
        raise ValueError('缺少因子版本快照；请使用 load_factor("版本ID") 的字面量调用')
    record = json.loads(path.read_text(encoding='utf-8')).get(version_id)
    if not record:
        raise ValueError(f'运行快照不包含因子版本 {version_id}，请使用字面量版本 ID')
    if sha256(record['source'].encode()).hexdigest() != record['source_hash']:
        raise ValueError('因子版本源码校验失败')
    return PublishedFactor(factor_from_source(record['source'], 'factor_' + version_id.replace('-', '_')),
                           record['parameters'], version_id)


def snapshot_factors(directory):
    """Keep dependency sources in run artifacts, including the persisted manifest."""
    path = Path.cwd() / 'factor-library.json'
    if not path.is_file():
        return {}
    records = json.loads(path.read_text(encoding='utf-8'))
    for record in records.values():
        if sha256(record['source'].encode()).hexdigest() != record['source_hash']:
            raise ValueError('因子版本源码校验失败')
    (Path(directory) / 'factor-library.json').write_text(
        json.dumps(records, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    return records
