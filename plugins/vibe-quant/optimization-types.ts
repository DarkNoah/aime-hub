export const OPTIMIZATION_METRICS = {
  sharpe: '夏普比率',
  total_return: '收益率',
  annual_return: '年化收益',
  max_drawdown: '最大回撤',
  sortino: '索提诺比率',
  calmar: '卡玛比率',
  profit_factor: '盈亏比 PF',
} as const;
export type OptimizationMetric = keyof typeof OPTIMIZATION_METRICS;
export type SearchParameter =
  | {
      type: 'int' | 'float';
      low: number;
      high: number;
      step?: number;
      log?: boolean;
    }
  | { type: 'categorical'; choices: (string | number | boolean | null)[] };
export interface OptimizationConfig {
  search_space: Record<string, SearchParameter>;
  metric: OptimizationMetric;
  n_trials: number;
  timeout_seconds: number;
  seed: number;
  min_trades: number;
  /** Training ends before this timestamp; validation starts with a fresh account. */
  validation_start?: number;
}
export interface OptimizationTrial {
  number: number;
  state: 'complete' | 'failed' | 'pruned' | 'cancelled';
  parameters: Record<string, unknown>;
  value: number | null;
  metrics: Record<string, number | null>;
  message: string;
}
export interface OptimizationReport {
  engine: 'optuna';
  optuna_version: string;
  sampler: 'TPESampler';
  seed: number;
  metric: OptimizationMetric;
  direction: 'maximize' | 'minimize';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  message: string;
  requested_trials: number;
  completed_trials: number;
  best_trial: number | null;
  best_run_id: string | null;
  best_value: number | null;
  best_parameters: Record<string, unknown> | null;
  training: { start: number; end: number };
  validation: {
    start: number;
    end: number;
    status: string;
    message: string;
    metrics: Record<string, number | null>;
  } | null;
  trials: OptimizationTrial[];
}
