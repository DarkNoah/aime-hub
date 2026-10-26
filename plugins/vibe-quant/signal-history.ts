import type { BacktestResult, OpenTrade, Trade } from './strategy-types.js';
import type { SignalMonitor, StrategySignal } from './signal-types.js';

export interface SignalHistorySummary extends Pick<
  BacktestResult,
  'metrics' | 'equity_curve' | 'monthly_returns' | 'yearly_returns'
> {
  start: number;
  through: number;
  initial_cash: number;
  replaying: boolean;
  open_trades: OpenTrade[];
  execution_model?: 'actual_contract' | 'continuous_price';
}
export interface SignalHistoryBatch {
  records: {
    kind: 'trade' | 'signal' | 'summary';
    id: string;
    time: number;
    payload: object;
  }[];
  summary?: SignalHistorySummary;
}
export interface SignalHistoryPage {
  monitor: SignalMonitor;
  summary: SignalHistorySummary | null;
  trades: Trade[];
  signals: StrategySignal[];
  next: string | null;
  signals_next: string | null;
}
