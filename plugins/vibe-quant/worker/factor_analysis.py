"""Cross-sectional futures research using closed bars and next-open forward returns."""
from collections import defaultdict
from datetime import datetime, timedelta
import json
from math import isfinite, sqrt
from pathlib import Path
from statistics import mean, stdev
import sys
from zoneinfo import ZoneInfo

if __name__ == '__main__':
    sys.path.insert(0, sys.argv[1])
from quant_sdk import Bar, TradingCalendar
from quant_sdk.factors import factor_from_source


def ranks(values):
    ordered = sorted(range(len(values)), key=values.__getitem__)
    result = [0.] * len(values)
    start = 0
    while start < len(values):
        end = start + 1
        while end < len(values) and values[ordered[end]] == values[ordered[start]]:
            end += 1
        for i in ordered[start:end]:
            result[i] = (start + end - 1) / 2
        start = end
    return result


def correlation(x, y):
    if len(x) < 3:
        return None
    mx, my = mean(x), mean(y)
    xx, yy = sum((v-mx)**2 for v in x), sum((v-my)**2 for v in y)
    if xx <= 1e-24 or yy <= 1e-24:
        return None
    return max(-1., min(1., sum((a-mx)*(b-my) for a, b in zip(x, y)) / sqrt(xx*yy)))


def average(values):
    clean = [value for value in values if value is not None]
    return mean(clean) if clean else None


def ratio(values):
    clean = [value for value in values if value is not None]
    sd = stdev(clean) if len(clean) > 1 else 0
    return mean(clean)/sd if sd > 1e-12 else None


def performance(returns, holding):
    equity, peak, drawdown = 1., 1., 0.
    for value in returns:
        equity *= 1 + value
        peak = max(peak, equity)
        drawdown = max(drawdown, (peak - equity) / peak)
    annualization = 252 / holding
    volatility = stdev(returns) * sqrt(annualization) if len(returns) > 1 else None
    annual = equity ** (annualization / len(returns)) - 1 if returns and equity > 0 else None
    return dict(total_return=equity-1, annual_return=annual if annual is None or isfinite(annual) else None,
                volatility=volatility, sharpe=(mean(returns) * annualization / volatility) if volatility and volatility > 1e-12 else None,
                max_drawdown=drawdown)


def daily_bars(raw, now):
    """Use the same explicit calendar and bar close policy as the strategy SDK."""
    from chinese_calendar import is_holiday
    zone = ZoneInfo('Asia/Shanghai')
    calendar_days = {}
    for row in raw:
        local = datetime.fromtimestamp(row['time'], zone)
        day = local.date() + timedelta(days=int(local.hour >= 18))
        for _ in range(32 if local.hour >= 18 or local.hour < 6 else 1):
            opened = day.weekday() < 5 and not is_holiday(day)
            calendar_days[day.isoformat()] = opened
            if opened:
                break
            day += timedelta(days=1)
    calendar = TradingCalendar(calendar_days)
    result = []
    for row in raw:
        end, day = calendar.bar_end(row['time'], 86400, futures=True)
        if end > now:
            continue
        result.append(Bar(symbol=row['symbol'], time=row['time'], end_time=end, trading_day=day,
                          duration=86400, **{k: row[k] for k in ('open', 'high', 'low', 'close', 'volume')}))
    return result


def analyze(factor, bars, config, parameters):
    symbols, count, holding = config['symbols'], config['groups'], config['holding_days']
    by_symbol = defaultdict(dict)
    for bar in bars:
        if bar.is_final:
            if bar.trading_day in by_symbol[bar.symbol]:
                raise ValueError(f'{bar.symbol} 同一交易日存在重复日线')
            by_symbol[bar.symbol][bar.trading_day] = bar
    values, coverage, latest, warnings = {}, [], [], []
    lookback = factor.lookback(parameters)
    if type(lookback) is not int or not 1 <= lookback <= 500:
        raise ValueError('因子 lookback 必须是 1 至 500 的整数')
    for symbol in symbols:
        history = sorted(by_symbol[symbol].values(), key=lambda bar: bar.end_time)
        computed = {}
        for i, bar in enumerate(history):
            if config['start'] <= bar.trading_day <= config['end']:
                # Never give the factor future rows, even when the entire snapshot is present.
                value = factor.evaluate(history[max(0, i-lookback+1):i+1], parameters)
                if value is not None:
                    computed[bar.trading_day] = value
        values[symbol] = computed
        if not computed:
            raise ValueError(f'{symbol} 在所选区间没有有效因子值，请检查行情覆盖和 lookback')
        day = max(computed)
        latest.append(dict(symbol=symbol, day=day, value=computed[day]))
        coverage.append(dict(symbol=symbol, bars=len(history), values=len(computed), first=min(computed), last=day))
    # Union calendar prevents missing observations from shortening the holding horizon.
    dates = sorted({day for rows in by_symbol.values() for day in rows
                    if config['start'] <= day <= config['end']})
    positions = {day: i for i, day in enumerate(dates)}
    signal_dates = [day for day in dates if all(day in values[s] for s in symbols)]
    if len(signal_dates) < 2:
        raise ValueError('共同交易日不足，无法进行横截面分析')

    def sample(day, horizon):
        pos = positions[day]
        if pos + horizon + 1 >= len(dates):
            return None
        window = dates[pos+1:pos+horizon+2]
        # Keep the universe fixed. Never pick survivors using future data availability.
        if any(any(d not in by_symbol[s] for d in window) for s in symbols):
            return None
        entry, end = window[0], window[-1]
        if any(by_symbol[s][entry].open <= 0 for s in symbols):
            return None
        forward = [by_symbol[s][end].open / by_symbol[s][entry].open - 1 for s in symbols]
        factor_values = [config['direction'] * values[s][day] for s in symbols]
        return factor_values, forward, by_symbol[symbols[0]][end].time

    ic = []
    for day in signal_dates:
        point = sample(day, holding)
        if point:
            x, y, _ = point
            ic.append(dict(time=by_symbol[symbols[0]][day].end_time,
                           ic=correlation(x, y), rank_ic=correlation(ranks(x), ranks(y))))
    returns = [[] for _ in range(count+1)]
    turnovers = [[] for _ in range(count)]
    previous = [set() for _ in range(count)]
    equities, curve = [1.] * (count+1), []
    skipped = 0
    # Non-overlapping holding windows. Missing data skips the whole scheduled period.
    for pos in range(positions[signal_dates[0]], len(dates)-holding-1, holding):
        day = dates[pos]
        point = sample(day, holding) if day in signal_dates else None
        if point is None:
            skipped += 1
            continue
        x, y, end_time = point
        # A constant factor has no ordering information; do not invent a portfolio.
        if max(x) - min(x) <= 1e-12:
            skipped += 1
            continue
        ordered = sorted(range(len(symbols)), key=lambda index: (x[index], symbols[index]))
        group_returns = []
        for group in range(count):
            members = ordered[group*len(symbols)//count:(group+1)*len(symbols)//count]
            selected = {symbols[index] for index in members}
            group_returns.append(mean(y[index] for index in members))
            if previous[group]:
                union = selected | previous[group]
                turnovers[group].append(sum(abs((1/len(selected) if s in selected else 0) -
                                               (1/len(previous[group]) if s in previous[group] else 0))
                                             for s in union) / 2)
            previous[group] = selected
        # 50% long high group, 50% short low group; gross notional exposure = 1.
        group_returns.append((group_returns[-1]-group_returns[0])/2)
        if any(value <= -1 for value in group_returns):
            raise ValueError('组合单期损失达到 100%，无法继续复利分析，请检查价格与区间')
        if not curve:
            curve.append(dict(time=by_symbol[symbols[0]][dates[pos+1]].time, values=[0.]*(count+1)))
        for group, value in enumerate(group_returns):
            returns[group].append(value)
            equities[group] *= 1+value
        curve.append(dict(time=end_time, values=[value-1 for value in equities]))
    if not curve:
        raise ValueError('没有可分析的完整持有区间，或所有横截面因子值相同')
    groups = [dict(name=f'分组 {i+1}' if i < count else '多空组合', **performance(result, holding),
                   turnover=average(turnovers[i]) if i < count else average(turnovers[0]+turnovers[-1]))
              for i, result in enumerate(returns)]
    ic_values = [row['ic'] for row in ic if row['ic'] is not None]
    rank_values = [row['rank_ic'] for row in ic if row['rank_ic'] is not None]
    ic_std = stdev(ic_values) if len(ic_values) > 1 else None
    decay = []
    for horizon in sorted({1, 5, 10, 20, holding}):
        samples = [sample(day, horizon) for day in signal_dates]
        decay.append(dict(days=horizon, ic=average([correlation(p[0], p[1]) for p in samples if p]),
                          rank_ic=average([correlation(ranks(p[0]), ranks(p[1])) for p in samples if p])))
    if skipped:
        warnings.append(f'{skipped} 个计划调仓点因数据缺失或因子值相同而跳过；未按未来数据筛除单个合约。')
    if any(row['first'] > config['start'] or row['last'] < config['end'] for row in coverage):
        warnings.append('有效因子值未覆盖所选区间的全部日期，请查看各合约的数据覆盖。')
    if len(set(item['value'] for item in latest)) < len(latest):
        warnings.append('相同因子值按合约代码稳定排序分组；大量并列值会降低分组区分度。')
    return dict(metrics=dict(ic_mean=average(ic_values), rank_ic_mean=average(rank_values), ic_std=ic_std,
                             ic_ir=ratio(ic_values), rank_ic_ir=ratio(rank_values),
                             t_stat=(mean(ic_values)/ic_std*sqrt(len(ic_values))) if ic_std and ic_std > 1e-12 else None,
                             positive_ic_ratio=average([int(v > .02) for v in ic_values]),
                             negative_ic_ratio=average([int(v < -.02) for v in ic_values]),
                             monotonicity=correlation(list(range(count)), ranks([g['total_return'] for g in groups[:count]])),
                             observations=len(ic_values), periods=len(returns[0])),
                groups=groups, curve=curve, ic=ic, decay=decay,
                latest=sorted(latest, key=lambda item: item['value'], reverse=True), coverage=coverage, warnings=warnings,
                methodology=[
                    '期货日线横截面分析；每次计算仅传入截至该交易日收盘的历史 K 线。',
                    '收盘因子对应下一交易日开盘至持有期结束后开盘的价格收益；分组按固定周期等权调仓，收益复利累计。',
                    '按方向调整后的因子从低到高分组；多空组合为 50% 多最高组、50% 空最低组，总名义敞口为 1。',
                    '仅使用已有行情快照；不包含手续费、滑点、保证金、主连换月价差及实际合约执行成本。',
                    '年化按 252 个交易日及有效持有期估计；IC 使用重叠日样本，t 值未作自相关修正。',
                    '净值在调仓点采样；回撤未包含持有期内及盘中波动。换手率是等权目标权重差，不含价格漂移与首次建仓。',
                    '固定所选合约池，未校正幸存者偏差；最新因子值不乘方向，可能属于不同交易日。',
                ])


if __name__ == '__main__':
    root = Path(sys.argv[2])
    raw = json.loads((root/'input.json').read_text(encoding='utf-8'))
    factor = factor_from_source(raw['source'])
    result = analyze(factor, daily_bars(raw['bars'], raw['now']), raw['config'], raw['parameters'])
    (root/'result.json').write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')
