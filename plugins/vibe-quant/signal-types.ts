import type { StrategyNotifications } from './strategy-notifications.js';
import type { BacktestInput } from './strategy-types.js';
import type { Engine } from './shared.js';

export interface SignalMonitorInput extends Pick<
  BacktestInput,
  | 'version_id'
  | 'symbol'
  | 'duration'
  | 'parameters'
  | 'rules'
  | 'initial_cash'
  | 'calendar'
> {
  warmup_days: number;
  events: { entry: boolean; exit: boolean };
}
export interface SignalMonitor {
  id: string;
  strategy_id: string;
  version_number: number;
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
}
