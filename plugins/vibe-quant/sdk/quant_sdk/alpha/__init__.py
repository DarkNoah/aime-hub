"""Published formula factors, with a causal multi-instrument evaluation entry point."""
from dataclasses import asdict
from math import isfinite

from ..factors import Factor
from .parser import parse, inspect


class ExpressionFactor(Factor):
    expression = ''
    family = 'worldquant101'

    def metadata(self):
        return inspect(parse(self.expression), self.family)

    def lookback(self, params):
        return self.metadata()['lookback']

    def compute(self, bars, params):
        if self.metadata()['cross_sectional']:
            raise ValueError('该公式需要同日横截面，请在因子分析中选择多个合约或调用 evaluate_panel')
        panel = self.evaluate_panel({bars[0].symbol: bars}, params)
        value = panel.iloc[-1, 0]
        return float(value) if isfinite(value) else None

    def evaluate_panel(self, histories, params=None):
        """Return date × symbol values. Missing data is never filled or approximated.

        Recursive GTJA SMA is initialized at the first finite observation in each
        trailing 500-day window. This matches the scalar Factor.evaluate contract.
        """
        import numpy as np
        import pandas as pd
        from .engine import PanelEngine
        info = self.metadata()
        rows = []
        for symbol, bars in histories.items():
            previous = None
            days = set()
            duration = None
            for bar in bars:
                if not bar.is_final:
                    continue
                if bar.duration != 86400:
                    raise ValueError('内置因子仅支持日线（86400 秒）')
                if bar.symbol != symbol or (previous is not None and bar.end_time <= previous):
                    raise ValueError('因子历史必须按合约和收盘时间递增')
                if bar.trading_day in days or (duration is not None and duration != bar.duration):
                    raise ValueError('内置因子面板每个交易日仅支持一根同周期 K 线')
                previous, duration = bar.end_time, bar.duration
                days.add(bar.trading_day)
                rows.append(asdict(bar))
        if not rows:
            raise ValueError('没有已收盘的行情')
        data = pd.DataFrame(rows)
        dates = sorted(data.trading_day.unique())
        fields = {}
        for name in info['fields']:
            if name not in data or not data[name].notna().any():
                raise ValueError(f'公式缺少必要数据：{name}；请提供真实字段，不使用价格或成交量代理')
            fields[name] = data.pivot(index='trading_day', columns='symbol', values=name).reindex(index=dates, columns=list(histories))
        if info['cross_sectional'] and len(histories) < 2:
            raise ValueError('横截面因子至少需要两个合约')
        # Keep the selected universe fixed. A date with absent input cannot silently
        # rank the remaining instruments as a different universe.
        valid = pd.DataFrame(True, index=dates, columns=list(histories))
        for frame in fields.values():
            valid &= frame.notna()
        if info['cross_sectional']:
            complete = valid.all(axis=1)
            fields = {name: frame.where(complete, np.nan) for name, frame in fields.items()}
        if info['recursive']:
            result = pd.DataFrame(np.nan, index=dates, columns=list(histories))
            for i in range(info['lookback']-1, len(dates)):
                window = {name: frame.iloc[i-499:i+1] for name, frame in fields.items()}
                result.iloc[i] = PanelEngine(window, self.family).evaluate(self.expression).iloc[-1]
        else:
            result = PanelEngine(fields, self.family).evaluate(self.expression)
        # Qlib supports partial rolling windows, but published factors intentionally
        # require their declared history before exposing a research observation.
        ready = valid.rolling(info['lookback'], min_periods=info['lookback']).sum() == info['lookback']
        return result.where(ready).replace([np.inf, -np.inf], np.nan)
