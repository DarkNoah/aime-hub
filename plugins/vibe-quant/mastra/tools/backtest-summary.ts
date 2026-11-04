import type { BacktestResult } from '../../strategy-types.js';

/** Keep completion notifications small; detailed rows remain available through backtest_result. */
export function backtestSummary(result: BacktestResult, hash: string) {
  return {
    status: result.status,
    pnl_unit: result.pnl_unit ?? 'currency',
    message: result.message,
    metrics: result.metrics,
    metric_notes: result.metric_notes,
    account: result.account,
    monthly_returns: result.monthly_returns,
    yearly_returns: result.yearly_returns,
    counts: Object.fromEntries(
      (
        [
          'trades',
          'orders',
          'fills',
          'signals',
          'logs',
          'equity_curve',
          'risk_levels',
        ] as const
      ).map((key) => [key, result[key]?.length ?? 0]),
    ),
    logs: result.logs.slice(-20),
    result_hash: hash,
  };
}
