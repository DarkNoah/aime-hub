import type { Bar, Engine } from './shared.js';

export interface ScriptDraft {
  source: string;
  parameters: Record<string, unknown>;
}
export interface StrategySummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  revision: number;
  version_count: number;
  updated_at: string;
}
export interface StrategyDetail extends StrategySummary {
  draft: ScriptDraft;
}
export interface StrategyVersion extends ScriptDraft {
  id: string;
  strategy_id: string;
  number: number;
  source_hash: string;
  note: string;
  created_at: string;
}
export interface BacktestInput {
  version_id: string;
  symbol: string;
  duration: number;
  /** Actual historical contracts by default; continuous prices are an explicit backtest approximation. */
  execution_model?: 'actual_contract' | 'continuous_price';
  start: number;
  end: number;
  initial_cash: number;
  slippage_ticks: number;
  participation_rate: number;
  annualization: number;
  risk_free_rate: number;
  benchmark_symbol: string | null;
  parameters: Record<string, unknown>;
  rules: {
    multiplier: number;
    margin_rate: number;
    lot_size: number;
    t_plus_one: boolean;
    fees: {
      per_unit: number;
      rate: number;
      minimum: number;
      close_today_per_unit: number | null;
      close_today_rate: number | null;
      sell_tax_rate: number;
    };
  };
  /** Optional exchange calendar override; absent uses the installed Chinese holiday calendar. */
  calendar?: Record<string, boolean>;
}
export type RunStatus =
  'queued' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface BacktestRun {
  id: string;
  strategy_id: string;
  version_id: string;
  version_number: number;
  source_hash: string;
  engine: Engine;
  status: RunStatus;
  message: string;
  config: BacktestInput;
  cancel_requested: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
export interface Trade {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entry_time: number;
  exit_time: number;
  entry_price: number;
  exit_price: number;
  gross_pnl: number;
  fees: number;
  net_pnl: number;
  entry_signal_id: string | null;
  exit_signal_id: string | null;
  /** Optional for historical results created before protective execution. */
  exit_reason?: string;
  exit_bar_time?: number;
  exit_time_precision?: 'open' | 'bar';
  risk_level_id?: string | null;
  trigger_price?: number | null;
  trigger_time?: number | null;
  trigger_bar_time?: number | null;
  trigger_time_precision?: 'open' | 'bar' | null;
}
/** Intrabar execution is anchored to its source candle, not the next candle. */
export const tradeExitAnchor = (trade: Trade) =>
  trade.exit_bar_time ?? trade.exit_time;
export interface BacktestResult {
  schema_version: number;
  run_id: string;
  status: string;
  message: string;
  metrics: Record<string, number | null>;
  equity_curve: {
    time: number;
    trading_day: string;
    equity: number;
    benchmark_equity: number | null;
  }[];
  monthly_returns: { period: string; return: number; pnl: number }[];
  yearly_returns: { period: string; return: number; pnl: number }[];
  trades: Trade[];
  orders: Record<string, unknown>[];
  fills: Record<string, unknown>[];
  signals: Record<string, unknown>[];
  /** Absent on results produced before risk-level recording was introduced. */
  risk_levels?: RiskLevelRecord[];
  logs: Record<string, unknown>[];
  account: Record<string, unknown>;
  metric_notes: Record<string, unknown>;
}
export interface RiskLevelRecord {
  id: string;
  event_id: string;
  time: number;
  symbol: string;
  entry_signal_id: string;
  stop_loss: number | null;
  take_profit: number | null;
}
export interface TradeReplay {
  trade: Trade;
  bars: Bar[];
  priceTick: number;
  snapshotHash: string;
  duration: number;
  targetTime: number | null;
  hasBefore: boolean;
  hasAfter: boolean;
  range: { start: number; end: number } | null;
  markerTimes: { entry: number | null; exit: number | null };
}
export const RUN_LABELS: Record<RunStatus, string> = {
  queued: '排队中',
  preparing: '准备数据',
  running: '回测中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
export const activeRun = (status: RunStatus) =>
  ['queued', 'preparing', 'running'].includes(status);
