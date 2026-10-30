import type { StrategyNotifications } from './strategy-notifications.js';
import type { BacktestInput, TradeRecord } from './strategy-types.js';
import type { Engine } from './shared.js';
import { DURATIONS, MONTH_DURATION } from './shared.js';

/** Published parameters set the calculation period independently of chart zoom. */
export function strategyHintDuration(parameters?: Record<string, unknown>) {
  const value = parameters?.duration;
  const duration =
    typeof value === 'number' || typeof value === 'string'
      ? Number(value)
      : NaN;
  return DURATIONS.find((item) => item !== MONTH_DURATION && item === duration);
}

export interface SignalMonitorInput extends Pick<
  BacktestInput,
  | 'version_id'
  | 'symbol'
  | 'duration'
  | 'parameters'
  | 'rules'
  | 'initial_cash'
  | 'calendar'
  | 'execution_model'
  | 'point_cost'
> {
  simulation_engine?: 'builtin' | 'tqsdk';
  tq_options?: BacktestInput['tq_options'];
  slippage_ticks?: number;
  history_start?: number;
  /** Chart attachment is independent of the instrument used for calculation. */
  display_symbol?: string;
  display_engine?: Engine;
  warmup_days: number;
  events: { entry: boolean; exit: boolean };
}
export function monitorExecutionModel(
  config: Pick<SignalMonitorInput, 'symbol' | 'execution_model'>,
) {
  return (
    config.execution_model ??
    (isIndexSymbol(config.symbol)
      ? 'points'
      : config.symbol.startsWith('KQ.m@')
        ? 'continuous_price'
        : 'actual_contract')
  );
}
export function isIndexSymbol(symbol: string) {
  return /^(SSE\.000|SZSE\.399)/.test(symbol);
}
export interface SignalMonitor {
  id: string;
  strategy_id: string;
  version_number: number;
  version_name?: string;
  engine: Engine;
  config: SignalMonitorInput;
  enabled: boolean;
  notifications_enabled?: boolean;
  notifications?: StrategyNotifications;
  revision: number;
  updated_at: string;
  status: 'starting' | 'running' | 'paused' | 'error';
  message: string;
}
export interface StrategySignal {
  id: string;
  monitor_id: string;
  type: 'entry' | 'exit';
  side: 'long' | 'short' | 'unknown';
  symbol: string;
  time: number;
  reason: string;
  price: number | null;
  /** Source candle/tick time, distinct from delivery time. */
  chart_time?: number;
}

export interface StrategyRiskLevel {
  chart_time?: number;
  id: string;
  symbol: string;
  entry_signal_id: string;
  time: number;
  stop_loss: number | null;
  take_profit: number | null;
  chart_stop_loss: number | null;
  chart_take_profit: number | null;
}
export interface SignalOverlay {
  updated_at: number | null;
  levels: StrategyRiskLevel[];
}
export interface MarketStrategyHint extends SignalMonitor {
  strategy_name: string;
  signals: StrategySignal[];
  overlay: SignalOverlay;
  trades?: TradeRecord[];
  trades_truncated?: boolean;
}
