import type { Bar, Engine } from './shared.js';
import type { OptimizationConfig } from './optimization-types.js';
import type { StrategyNotifications } from './strategy-notifications.js';

export interface ScriptDraft {
  source: string;
  parameters: Record<string, unknown>;
}
export type StrategyStatus = 'active' | 'archived' | 'deleted';
export const STRATEGY_STATUS_LABELS: Record<StrategyStatus, string> = {
  active: '当前策略',
  archived: '已归档',
  deleted: '回收站',
};
export interface StrategySummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: StrategyStatus;
  revision: number;
  version_count: number;
  updated_at: string;
}
export interface StrategyDetail extends StrategySummary {
  draft: ScriptDraft;
  notifications: StrategyNotifications;
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
  optimization?: OptimizationConfig;
  version_id: string;
  symbol: string;
  duration: number;
  /** Actual historical contracts by default; continuous prices are an explicit backtest approximation. */
  execution_model?: 'actual_contract' | 'continuous_price' | 'points';
  /** Per-side cost in price points, only for fixed-one-unit point backtests. */
  point_cost?: number;
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
      /** Omitted on historical runs: per-unit and notional fees are combined. */
      mode?: 'fixed' | 'rate' | 'combined';
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
export const POINT_BACKTEST_RULES: BacktestInput['rules'] = {
  multiplier: 1,
  margin_rate: 1,
  lot_size: 1,
  t_plus_one: false,
  fees: {
    mode: 'fixed',
    per_unit: 0,
    rate: 0,
    minimum: 0,
    close_today_per_unit: null,
    close_today_rate: null,
    sell_tax_rate: 0,
  },
};
export interface BacktestRun {
  /** A successful optimization creates a separate, unpublished strategy. */
  optimization_draft_id?: string;
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
  /** Monitor-owned protection snapshots, retained after a position closes. */
  risk_levels?: RiskLevelRecord[];
  status?: 'closed';
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
export interface OpenTrade extends Omit<
  Trade,
  | 'status'
  | 'exit_time'
  | 'exit_price'
  | 'gross_pnl'
  | 'net_pnl'
  | 'exit_signal_id'
> {
  status: 'open';
  exit_time: null;
  exit_price: null;
  gross_pnl: null;
  net_pnl: null;
  exit_signal_id: null;
  /** Last observed account time; risk drawings must not extend beyond the run. */
  observed_until: number;
}
export type TradeRecord = Trade | OpenTrade;
/** Intrabar execution is anchored to its source candle, not the next candle. */
export const tradeExitAnchor = (trade: TradeRecord) =>
  trade.status === 'open' ? null : (trade.exit_bar_time ?? trade.exit_time);
export const tradeHoldingEnd = (trade: TradeRecord) =>
  trade.status === 'open' ? trade.observed_until : trade.exit_time;
export interface BacktestResult {
  pnl_unit?: 'currency' | 'points';
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
  monthly_returns: { period: string; return: number | null; pnl: number }[];
  yearly_returns: { period: string; return: number | null; pnl: number }[];
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
  trade: TradeRecord;
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
