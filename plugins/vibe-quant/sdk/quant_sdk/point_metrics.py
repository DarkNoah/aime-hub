"""Absolute price-point statistics, without an arbitrary capital denominator."""
from collections import defaultdict


def summarize_points(curve: list[dict], trades: list[dict]) -> dict:
    final = curve[-1]['equity'] if curve else 0.0
    peak = drawdown = 0.0
    daily = {}
    for point in curve:
        peak = max(peak, point['equity'])
        drawdown = max(drawdown, peak - point['equity'])
        daily[point['trading_day']] = point
    realized = sum(trade['net_pnl'] for trade in trades)
    gains = sum(max(trade['net_pnl'], 0) for trade in trades)
    losses = -sum(min(trade['net_pnl'], 0) for trade in trades)
    monthly, yearly = defaultdict(list), defaultdict(list)
    for point in daily.values():
        monthly[point['trading_day'][:7]].append(point)
        yearly[point['trading_day'][:4]].append(point)

    def periods(groups):
        previous, result = 0.0, []
        for period, values in groups.items():
            value = values[-1]['equity']
            result.append({'period': period, 'return': None, 'pnl': value - previous})
            previous = value
        return result

    metrics = dict.fromkeys(('total_return', 'annual_return', 'max_drawdown', 'sharpe',
                             'benchmark_return', 'benchmark_annual_return', 'sortino', 'calmar'))
    metrics.update(total_pnl=final, total_points=final, final_equity=final,
                   realized_points=realized, unrealized_points=final - realized,
                   max_drawdown_points=drawdown, trade_count=len(trades),
                   average_trade_points=realized / len(trades) if trades else None,
                   win_rate=sum(t['net_pnl'] > 0 for t in trades) / len(trades) if trades else None,
                   profit_factor=gains / losses if losses else None,
                   benchmark_points=curve[-1].get('benchmark_equity') if curve else None)
    return {'metrics': metrics, 'monthly_returns': periods(monthly), 'yearly_returns': periods(yearly),
            'metric_notes': {'pnl_unit': 'points', 'position': 'fixed one unit per direction; target magnitude ignored',
                             'returns': 'absolute price changes net of per-side point costs and slippage; no currency returns',
                             'drawdown': 'peak-to-trough cumulative points, starting at zero; includes open positions',
                             'unrealized_points': 'mark-to-market remainder including costs already paid on open positions',
                             'trade_count': 'closed trades only; open positions marked to market',
                             'undefined': 'capital-based ratios are null; no arbitrary initial-cash denominator'}}
