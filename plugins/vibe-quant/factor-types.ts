export interface FactorDraft {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  parameters: Record<string, unknown>;
}

export interface FactorVersion {
  id: string;
  factor_id: string;
  number: number;
  source: string;
  source_hash: string;
  parameters: Record<string, unknown>;
  note: string;
  created_at: string;
}

export interface FactorSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  revision: number;
  version_count: number;
  updated_at: string;
}

export interface FactorDetail extends FactorSummary {
  source: string;
  parameters: Record<string, unknown>;
  versions: FactorVersion[];
}

export interface FactorAnalysisInput {
  version_id: string | null;
  symbols: string[];
  start: string;
  end: string;
  holding_days: number;
  groups: number;
  direction: 1 | -1;
}

export interface FactorMetrics {
  total_return: number;
  annual_return: number | null;
  volatility: number | null;
  sharpe: number | null;
  max_drawdown: number;
}

export interface FactorReport {
  metrics: {
    ic_mean: number | null;
    rank_ic_mean: number | null;
    ic_std: number | null;
    ic_ir: number | null;
    rank_ic_ir: number | null;
    t_stat: number | null;
    positive_ic_ratio: number | null;
    negative_ic_ratio: number | null;
    monotonicity: number | null;
    observations: number;
    periods: number;
  };
  groups: (FactorMetrics & { name: string; turnover: number | null })[];
  curve: { time: number; values: number[] }[];
  ic: { time: number; ic: number | null; rank_ic: number | null }[];
  decay: { days: number; ic: number | null; rank_ic: number | null }[];
  latest: { symbol: string; day: string; value: number }[];
  coverage: {
    symbol: string;
    bars: number;
    values: number;
    first: string;
    last: string;
  }[];
  warnings: string[];
  methodology: string[];
}

export interface FactorAnalysis {
  id: string;
  factor_id: string;
  created_at: string;
  finished_at: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  message: string;
  config: FactorAnalysisInput;
  source_hash: string;
  source: string;
  parameters: Record<string, unknown>;
  report: FactorReport | null;
}

export type FactorAnalysisSummary = Omit<FactorAnalysis, 'source' | 'report'>;
