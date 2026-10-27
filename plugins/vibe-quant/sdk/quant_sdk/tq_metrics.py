"""Presentation mapping only: every performance statistic is calculated by TqSdk."""
from math import isfinite
from copy import deepcopy


def clean(value):
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items() if not str(k).startswith('_')}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if hasattr(value, 'item'):
        return clean(value.item())
    if isinstance(value, float) and not isfinite(value):
        return None
    return value


def performance(sim, quote=None):
    # tqsdk_stat is authoritative after an ordinary TqBacktest finishes.
    stats = dict(getattr(sim, 'tqsdk_stat', {}))
    logs = deepcopy(getattr(sim, 'trade_log', {}))
    if hasattr(sim, 'report_log'):
        logs = sim.report_log()  # Native current-day account/trades, without forcing settlement.
    report = None
    if logs:
        from tqsdk.report import TqReport
        quotes = {f"{t['exchange_id']}.{t['instrument_id']}": {'volume_multiple': quote.volume_multiple}
                  for day in logs.values() for t in day['trades']} if quote is not None else {}
        report = lambda rows: TqReport('strategy', trade_log=rows, quotes=quotes).default_metrics
        if not stats:
            stats = report(logs)
    stats = clean(stats)
    mapping = {'total_return': 'ror', 'annual_return': 'annual_yield', 'max_drawdown': 'max_drawdown',
               'sharpe': 'sharpe_ratio', 'sortino': 'sortino_ratio', 'calmar': 'calmar_ratio',
               'win_rate': 'winning_rate', 'trade_count': 'close_times', 'final_equity': 'balance',
               'profit_loss_ratio': 'profit_loss_ratio', 'commission': 'commission'}
    metrics = {key: stats.get(source) for key, source in mapping.items()}
    metrics.update(total_pnl=stats['balance'] - stats['init_balance']
                   if stats.get('balance') is not None and stats.get('init_balance') is not None else None,
                   profit_factor=None, benchmark_return=None, benchmark_annual_return=None)
    def periods(length):
        if not report:
            return []
        groups = {}
        for day, value in sorted(logs.items()):
            groups.setdefault(day[:length], {})[day] = value
        result = []
        for period, rows in groups.items():
            values = clean(report(rows))
            result.append({'period': period, 'return': values.get('ror'),
                           'pnl': values['balance'] - values['init_balance']})
        return result
    return {'metrics': metrics, 'monthly_returns': periods(7), 'yearly_returns': periods(4),
            'native_metrics': stats, 'metrics_source': 'TqSim/TqReport',
            'metric_notes': {'source': 'TqSim.tqsdk_stat / tqsdk.report.TqReport',
                'trade_count': 'native close fills, not FIFO fragments',
                'win_rate': 'TqSdk winning_rate: per-lot, before fees; flat lots count as wins',
                'annualization': 'TqSdk defaults (250 trading days); no local annualization/risk-free override',
                'undefined': 'non-finite/unsupported values are null'}}
