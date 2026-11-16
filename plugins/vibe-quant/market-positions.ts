import type { SignalMonitor } from './signal-types.js';
import type { OpenTrade, Trade } from './strategy-types.js';

export interface MarketPositionMonitor extends SignalMonitor {
  strategy_name: string;
  through: number | null;
  replaying: boolean;
}

export interface MarketPosition<T = OpenTrade | Trade> {
  monitor_id: string;
  trade: T;
}

/** Closed trades grouped by their exit month in Asia/Shanghai. */
export interface MarketPositionMonth {
  month: string;
  unit: 'currency' | 'points';
  net_pnl: number;
  gross_profit: number;
  gross_loss: number;
  winning_trades: number;
  losing_trades: number;
  breakeven_trades: number;
}

export interface MarketPositionsPage {
  strategies: { id: string; name: string }[];
  monitors: MarketPositionMonitor[];
  open: MarketPosition<OpenTrade>[];
  history: MarketPosition<Trade>[];
  monthly: MarketPositionMonth[];
  next: string | null;
}
