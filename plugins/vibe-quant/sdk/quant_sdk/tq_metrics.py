"""TqSim reporting, including optional strategy-specified protective exit P&L."""
from dataclasses import dataclass, field
from math import isfinite
from copy import deepcopy


@dataclass
class ExitAccounting:
    daily_adjustments: dict[str, float] = field(default_factory=dict)
    total_adjustment: float = 0.0
    win_volume: int = 0
    loss_volume: int = 0
    profits: float = 0.0
    losses: float = 0.0

    def record(self, day, size, gross, fees, override):
        outcome = gross
        if override is not None:
            adjustment = override - (gross - fees)
            self.daily_adjustments[day] = self.daily_adjustments.get(day, 0.0) + adjustment
            self.total_adjustment += adjustment
            outcome = override
        if outcome >= 0:
            self.win_volume += size
            self.profits += outcome
        else:
            self.loss_volume += size
            self.losses -= outcome

    def apply(self, logs):
        # These are private copies of the provider's daily account snapshots.
        prior = 0.0
        for day, value in sorted(logs.items()):
            account = value['account']
            account['pre_balance'] += prior
            prior += self.daily_adjustments.get(day, 0)
            account['balance'] += prior

    @classmethod
    def from_native(cls, stats):
        # Legacy live checkpoints may already have compacted their closed lots.
        return cls(win_volume=stats.get('profit_volumes') or 0, loss_volume=stats.get('loss_volumes') or 0,
                   profits=stats.get('profit_value') or 0.0, losses=-(stats.get('loss_value') or 0.0))


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


def performance(sim, quote=None, accounting=None):
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
    native_stats = clean(stats)
    adjusted = accounting is not None and bool(accounting.daily_adjustments)
    if adjusted and report:
        accounting.apply(logs)
        stats = clean(report(logs))
    else:
        stats = dict(native_stats)
    if adjusted:
        if not report and stats.get('balance') is not None:
            # Providers exposing only aggregate statistics have no daily risk series.
            stats['balance'] += accounting.total_adjustment
            initial = stats.get('init_balance')
            stats['ror'] = stats['balance'] / initial - 1 if initial else None
            for key in ('annual_yield', 'max_drawdown', 'sharpe_ratio', 'sortino_ratio', 'calmar_ratio'):
                stats[key] = None
        volume = accounting.win_volume + accounting.loss_volume
        stats['winning_rate'] = accounting.win_volume / volume if volume else None
        avg_profit = accounting.profits / accounting.win_volume if accounting.win_volume else 0.0
        avg_loss = accounting.losses / accounting.loss_volume if accounting.loss_volume else 0.0
        stats['profit_loss_ratio'] = avg_profit / avg_loss if avg_loss else None
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
            'native_metrics': native_stats, 'metrics_source': 'quant_sdk/TqSim' if adjusted else 'TqSim/TqReport',
            'metric_notes': {'source': ('TqReport on daily balances adjusted by realized protective exit overrides'
                                        if adjusted else 'TqSim.tqsdk_stat / tqsdk.report.TqReport'),
                'trade_count': 'native close fills, not FIFO fragments',
                'win_rate': ('Per attributed lot: final specified P&L for overridden exits, otherwise gross P&L; flat lots count as wins'
                             if adjusted else 'TqSdk winning_rate: per-lot, before fees; flat lots count as wins'),
                'annualization': 'TqSdk defaults (250 trading days); no local annualization/risk-free override',
                'undefined': 'non-finite/unsupported values are null'}}
