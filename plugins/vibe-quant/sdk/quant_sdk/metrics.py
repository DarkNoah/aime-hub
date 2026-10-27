"""Statistics have explicit units and nulls for undefined ratios."""
from collections import defaultdict
from datetime import date
from math import isfinite, sqrt
from statistics import mean, stdev


def summarize(curve: list[dict], trades: list[dict], config) -> dict:
    if config.pnl_mode == 'points':
        from .point_metrics import summarize_points
        return summarize_points(curve, trades)
    initial = config.initial_cash
    daily = {}
    for point in curve:
        daily[point['trading_day']] = point
    points = list(daily.values())
    final = points[-1]['equity'] if points else initial
    returns, previous, peak, drawdown = [], initial, initial, 0.0
    for point in curve:
        peak = max(peak, point['equity'])
        drawdown = max(drawdown, (peak - point['equity']) / peak)
    for point in points:
        returns.append(point['equity'] / previous - 1 if previous > 0 else 0.0)
        previous = point['equity']
    elapsed = (date.fromisoformat(points[-1]['trading_day']) - date.fromisoformat(points[0]['trading_day'])).days + 1 if points else 0
    years = elapsed / 365.25
    def annual(value):
        if years <= 0 or value <= 0:
            return None
        try:
            result = value ** (1 / years) - 1
            return result if isfinite(result) else None
        except OverflowError:
            return None
    annual_return = annual(final / initial)
    excess = [r - config.risk_free_rate / config.annualization for r in returns]
    volatility = stdev(excess) if len(excess) > 1 else 0
    downside = sqrt(mean([min(r, 0) ** 2 for r in excess])) if excess else 0
    positive = sum(max(t['net_pnl'], 0) for t in trades)
    negative = -sum(min(t['net_pnl'], 0) for t in trades)
    benchmark = points[-1].get('benchmark_equity') if points else None
    monthly, yearly = defaultdict(list), defaultdict(list)
    for point in points:
        monthly[point['trading_day'][:7]].append(point)
        yearly[point['trading_day'][:4]].append(point)
    def periods(groups):
        prior = initial
        result = []
        for period, values in groups.items():
            equity = values[-1]['equity']
            result.append({'period': period, 'return': equity / prior - 1 if prior > 0 else None, 'pnl': equity - prior})
            prior = equity
        return result
    return {'metrics': {
        'total_pnl': final - initial, 'total_return': final / initial - 1,
        'annual_return': annual_return, 'max_drawdown': drawdown,
        'sharpe': mean(excess) / volatility * sqrt(config.annualization) if volatility else None,
        'trade_count': len(trades), 'final_equity': final,
        'benchmark_return': benchmark / initial - 1 if benchmark is not None else None,
        'benchmark_annual_return': annual(benchmark / initial) if benchmark is not None else None,
        'sortino': mean(excess) / downside * sqrt(config.annualization) if downside else None,
        'calmar': annual_return / drawdown if annual_return is not None and drawdown else None,
        'profit_factor': positive / negative if negative else None,
    }, 'monthly_returns': periods(monthly), 'yearly_returns': periods(yearly),
        'metric_notes': {'returns': 'decimal ratios, net of fees; open positions marked to market',
                         'annual_return': 'CAGR using elapsed calendar days; short samples can be unstable',
                         'sharpe': 'daily sampled equity returns; annualization and risk-free rate from config',
                         'trade_count': 'FIFO closed lots; order and fill counts are separate',
                         'undefined': 'null means absent benchmark, zero denominator or insufficient observations'}}
