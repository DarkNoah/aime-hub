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

export interface MarketPositionsPage {
  monitors: MarketPositionMonitor[];
  open: MarketPosition<OpenTrade>[];
  history: MarketPosition<Trade>[];
  next: string | null;
}
