import type { BacktestInput, BacktestRun } from './strategy-types.js';
import type { SignalMonitor } from './signal-types.js';

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );

/** Never attribute another instrument, version, timeframe or parameter set to this hint. */
export function matchesMonitorRun(
  monitor: Pick<SignalMonitor, 'strategy_id' | 'engine' | 'config'>,
  run: BacktestRun,
) {
  return (
    run.strategy_id === monitor.strategy_id &&
    run.version_id === monitor.config.version_id &&
    run.engine === monitor.engine &&
    run.config.symbol === monitor.config.symbol &&
    run.config.duration === monitor.config.duration &&
    canonical(run.config.parameters) === canonical(monitor.config.parameters) &&
    !run.config.optimization
  );
}

export function monitorHistoryInput(
  monitor: Pick<SignalMonitor, 'strategy_id' | 'engine' | 'config'>,
  months: 3 | 12 | 36,
  now = Math.floor(Date.now() / 1000),
): BacktestInput {
  const config = structuredClone(monitor.config);
  return {
    version_id: config.version_id,
    symbol: config.symbol,
    duration: config.duration,
    parameters: config.parameters,
    rules: config.rules,
    initial_cash: config.initial_cash,
    ...(config.calendar ? { calendar: config.calendar } : {}),
    execution_model: 'actual_contract',
    start: now - Math.round(((months * 365.25) / 12) * 86400),
    end: now,
    slippage_ticks: 1,
    participation_rate: 0.1,
    annualization: 252,
    risk_free_rate: 0,
    benchmark_symbol: config.symbol,
  };
}
