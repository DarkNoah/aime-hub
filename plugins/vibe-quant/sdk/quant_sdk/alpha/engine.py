"""Causal panel operators. Rows are trading days; columns are fixed instruments.

No eval, filling missing prices, proxy VWAP, or time-series substitution for rank.
WorldQuant/GTJA use complete rolling windows; Qlib uses its min_periods=1 policy.
"""
import operator
import numpy as np
import pandas as pd

from .parser import parse


class PanelEngine:
    def __init__(self, fields, family):
        self.fields, self.family = fields, family
        self.template = next(iter(fields.values()))
        self.qlib = family.startswith('qlib')
        self.cache = {}

    def frame(self, value):
        if isinstance(value, pd.DataFrame):
            return value
        return pd.DataFrame(value, index=self.template.index, columns=self.template.columns)

    def roll(self, value, window):
        n = int(window)
        if n < 1:
            raise ValueError('滚动窗口必须为正数')
        return self.frame(value).rolling(n, min_periods=1 if self.qlib else n)

    def evaluate(self, expression):
        with np.errstate(all='ignore'):
            result = self.frame(self.node(parse(expression))).astype(float)
        return result.replace([np.inf, -np.inf], np.nan)

    def node(self, node):
        if node in self.cache:
            return self.cache[node]
        kind, name, *rest = node
        if kind == 'number':
            return name
        if kind == 'field':
            if name not in self.fields:
                raise ValueError(f'公式缺少必要数据：{name}')
            return self.fields[name]
        if kind == 'unary':
            result = self.node(rest[0]) * (-1 if name == '-' else 1)
        elif kind == 'binary':
            a, b = [self.node(n) for n in rest]
            ops = {'+': operator.add, '-': operator.sub, '*': operator.mul,
                   '/': operator.truediv, '^': operator.pow, '=': operator.eq,
                   '==': operator.eq, '!=': operator.ne, '<': operator.lt,
                   '>': operator.gt, '<=': operator.le, '>=': operator.ge}
            if name in ('&', '&&', '|', '||'):
                op = np.logical_and if name in ('&', '&&') else np.logical_or
                result = self.frame(op(self.frame(a), self.frame(b))).astype(float)
            else:
                result = self.frame(ops[name](a, b)).astype(float)
            # Comparisons of missing values are missing, not a fabricated False.
            result = result.where(self.frame(a).notna() & self.frame(b).notna())
        else:
            result = self.call(name, [self.node(n) for n in rest[0]])
        self.cache[node] = result
        return result

    def call(self, name, args):
        a = args[0]
        if name in ('abs', 'log', 'sign'):
            return {'abs': np.abs, 'log': np.log, 'sign': np.sign}[name](a)
        if name == 'signedpower':
            return np.sign(a) * (np.abs(a) ** args[1])
        if name == 'where':
            cond, yes, no = map(self.frame, args)
            return yes.where(cond.fillna(0).astype(bool), no).where(cond.notna())
        if name == 'filter':
            return self.frame(a).where(self.frame(args[1]).fillna(0).astype(bool))
        if name in ('delay', 'delta'):
            n = int(args[1]) if len(args) > 1 else 1
            if n < 0:
                raise ValueError('因子不允许读取未来数据')
            shifted = self.frame(a).shift(n)
            return shifted if name == 'delay' else a - shifted
        if name == 'rank' and not self.qlib:
            if self.template.shape[1] < 2:
                raise ValueError('横截面因子需要同日多合约数据，请使用因子分析或 evaluate_panel')
            return self.frame(a).rank(axis=1, method='average', pct=True)
        if name == 'scale':
            total = self.frame(a).abs().sum(axis=1).replace(0, np.nan)
            return self.frame(a).div(total, axis=0) * (args[1] if len(args) > 1 else 1)
        if name == 'indneutralize':
            data, groups = map(self.frame, args)
            output = data.copy() * np.nan
            for day in data.index:
                output.loc[day] = data.loc[day] - data.loc[day].groupby(groups.loc[day]).transform('mean')
            return output
        if name in ('min', 'max', 'greater', 'less'):
            b = args[1]
            if name in ('min', 'max') and np.isscalar(b) and b > 0:
                return getattr(self.roll(a, b), name)()
            return (np.maximum if name in ('max', 'greater') else np.minimum)(a, b)
        if name == 'sequence':
            return np.arange(1, int(a) + 1, dtype=float)
        if name == 'regbeta' and isinstance(args[1], np.ndarray):
            return self.regression(a, len(args[1]), 'slope')
        if name == 'regresi':
            return self.multiple_regression(args[0], args[1:-1], int(args[-1]))
        if name in ('correlation', 'covariance', 'regbeta'):
            a, b, window = args
            roll = self.roll(a, window)
            if name == 'correlation':
                result = roll.corr(self.frame(b))
                # Qlib explicitly treats constant inputs as undefined.
                return result.where((roll.std() > 1e-12) & (self.roll(b, window).std() > 1e-12))
            if name == 'covariance':
                return roll.cov(self.frame(b), ddof=1)
            # FILTER keeps the date axis; regression uses paired selected samples.
            return self.pair_beta(a, b, int(window))
        if name == 'sma':
            _, n, m = args
            if not 0 < m <= n:
                raise ValueError('SMA 需要 0 < m <= n')
            return self.frame(a).ewm(alpha=m/n, adjust=False, ignore_na=True).mean().where(self.frame(a).notna())
        if name == 'selfalpha':
            close = self.frame(a)
            returns = close / close.shift(1) - 1
            return returns.where(close > close.shift(1), 1).cumprod().where(close.notna())
        n = int(args[1])
        if name in ('slope', 'rsquare', 'resi'):
            return self.regression(a, n, name)
        rolling = self.roll(a, n)
        if name in ('sum', 'mean', 'ts_min', 'ts_max', 'count'):
            method = {'ts_min': 'min', 'ts_max': 'max', 'count': 'sum'}.get(name, name)
            return getattr(rolling, method)()
        if name == 'stddev':
            return rolling.std(ddof=1)
        if name == 'quantile':
            return rolling.quantile(args[2])
        if name == 'sumif':
            return self.roll(self.call('where', [args[2], a, 0]), n).sum()
        if name in ('rank', 'ts_rank'):
            return rolling.rank(method='average', pct=True)
        if name in ('ts_argmax', 'ts_argmin', 'highday', 'lowday'):
            maximum = name in ('ts_argmax', 'highday')
            def position(x):
                index = (np.nanargmax if maximum else np.nanargmin)(x)
                return len(x)-index-1 if name in ('highday', 'lowday') else index+1
            return rolling.apply(position, raw=True)
        if name == 'product':
            return rolling.apply(np.prod, raw=True)
        if name in ('decay_linear', 'wma'):
            weights = np.arange(1, n+1) if name == 'decay_linear' else 0.9 ** np.arange(n-1, -1, -1)
            return rolling.apply(lambda x: np.dot(x, weights[-len(x):]) / weights[-len(x):].sum(), raw=True)
        if name == 'rsrange':
            def rs(x):
                cumulative = np.cumsum(x - x.mean())
                sd = x.std(ddof=1)
                return (cumulative.max()-cumulative.min())/sd if sd > 0 else np.nan
            return rolling.apply(rs, raw=True)
        raise ValueError(f'不支持的公式算子：{name}')

    def regression(self, value, window, mode):
        def fit(y):
            x = np.arange(1, len(y)+1, dtype=float)
            valid = np.isfinite(y)
            if valid.sum() < 2 or not valid[-1]:
                return np.nan
            x, clean = x[valid], y[valid]
            xx, yy = x-x.mean(), clean-clean.mean()
            beta = np.dot(xx, yy) / np.dot(xx, xx)
            if mode == 'slope':
                return beta
            if mode == 'resi':
                return clean[-1] - (clean.mean() + beta*xx[-1])
            denom = np.dot(yy, yy)
            return beta**2*np.dot(xx,xx)/denom if denom > 1e-24 else np.nan
        return self.roll(value, window).apply(fit, raw=True)

    def pair_beta(self, a, b, window):
        a, b = self.frame(a), self.frame(b)
        valid = a.notna() & b.notna()
        x, y = b.where(valid), a.where(valid)
        return y.rolling(window, min_periods=2).cov(x) / x.rolling(window, min_periods=2).var()

    def multiple_regression(self, y, xs, window):
        y, xs = self.frame(y), [self.frame(x) for x in xs]
        output = y.copy() * np.nan
        for col in y.columns:
            predictors = np.column_stack([np.ones(len(y))] + [x[col].values for x in xs])
            for i in range(window-1, len(y)):
                x, target = predictors[i-window+1:i+1], y[col].values[i-window+1:i+1]
                if not np.isfinite(x).all() or not np.isfinite(target).all():
                    continue
                beta, _, rank, _ = np.linalg.lstsq(x, target, rcond=None)
                if rank == x.shape[1]:
                    output.loc[y.index[i], col] = target[-1] - x[-1] @ beta
        return output
