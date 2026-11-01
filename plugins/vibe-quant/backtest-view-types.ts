import type {
  BacktestResult,
  RiskLevelRecord,
  TradeRecord,
} from './strategy-types.js';

export interface BacktestTradePage {
  items: TradeRecord[];
  total: number;
  page_size: number;
}

export interface BacktestOverview extends Pick<
  BacktestResult,
  'metrics' | 'equity_curve' | 'monthly_returns' | 'yearly_returns'
> {
  curve_points: number;
  closed_win_rate: number | null;
  trades: BacktestTradePage;
}

export interface BacktestView {
  result: BacktestOverview | null;
  manifest: Record<string, unknown> | null;
}

export interface BacktestLogs {
  counts: Record<
    'orders' | 'fills' | 'signals' | 'logs' | 'risk_levels',
    number
  >;
  orders: Record<string, unknown>[];
  logs: Record<string, unknown>[];
  risk_levels: RiskLevelRecord[];
  account: Record<string, unknown>;
}
