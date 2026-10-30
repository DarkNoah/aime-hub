import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { BacktestRun } from '../../strategy-types.js';
import { StrategyError } from './schema.js';

const periodSchema = z.object({
  period: z.string(),
  return: z.number().nullable(),
  pnl: z.number(),
});
const resultSchema = z.object({
  status: z.literal('succeeded'),
  pnl_unit: z.enum(['currency', 'points']).optional(),
  metrics_source: z.string().optional(),
  metrics: z.record(z.string(), z.number().nullable()),
  metric_notes: z.record(z.string(), z.unknown()).default({}),
  monthly_returns: z.array(periodSchema).default([]),
  yearly_returns: z.array(periodSchema).default([]),
  equity_curve: z
    .array(
      z.object({
        time: z.number(),
        trading_day: z.string(),
      }),
    )
    .default([]),
  trades: z.array(z.object({ net_pnl: z.number() })).default([]),
});
type PeriodReturn = z.infer<typeof periodSchema>;
type Coverage = {
  first_time: number;
  last_time: number;
  trading_days: string[];
  observations: number;
};

export function validateComparisonRuns(runs: BacktestRun[]) {
  if (runs.length < 2)
    throw new StrategyError('BACKTEST_COMPARISON_REQUIRES_TWO_RUNS', 400);
  if (runs.some((run) => run.strategy_id !== runs[0].strategy_id))
    throw new StrategyError('BACKTEST_COMPARISON_STRATEGY_MISMATCH', 400);
  if (new Set(runs.map((run) => run.version_id)).size !== runs.length)
    throw new StrategyError(
      'BACKTEST_COMPARISON_REQUIRES_DISTINCT_VERSIONS',
      400,
    );
}

/** Keep only small summaries; a comparison must not retain every run's trades/curve. */
export function prepareBacktestComparison(
  run: BacktestRun,
  text: string,
  resultHash: string,
) {
  const result = resultSchema.parse(JSON.parse(text));
  const points =
    (result.pnl_unit ??
      (run.config.execution_model === 'points' ? 'points' : 'currency')) ===
    'points';
  const native = run.config.backtest_engine === 'tqsdk';
  const metrics = { ...result.metrics };
  const metricNotes = { ...result.metric_notes };
  if (!native && !Object.hasOwn(metrics, 'win_rate')) {
    metrics.win_rate = result.trades.length
      ? result.trades.filter((trade) => trade.net_pnl > 0).length /
        result.trades.length
      : null;
    metricNotes.win_rate =
      '已平仓交易净盈亏大于零的笔数 / 已平仓交易总数；持平计入分母，未平仓不计入。';
  }
  const coverage = new Map<string, Coverage>();
  const days = new Map<string, Set<string>>();
  for (const point of result.equity_curve) {
    for (const key of [
      'all',
      point.trading_day.slice(0, 4),
      point.trading_day.slice(0, 7),
    ]) {
      const existing = coverage.get(key);
      if (existing) {
        existing.first_time = Math.min(existing.first_time, point.time);
        existing.last_time = Math.max(existing.last_time, point.time);
        existing.observations++;
      } else {
        coverage.set(key, {
          first_time: point.time,
          last_time: point.time,
          observations: 1,
          trading_days: [],
        });
        days.set(key, new Set());
      }
      days.get(key)!.add(point.trading_day);
    }
  }
  for (const [key, value] of coverage)
    value.trading_days = [...days.get(key)!].sort();
  const periods = (rows: PeriodReturn[], pattern: RegExp) => {
    const map = new Map<string, PeriodReturn>();
    for (const row of rows) {
      if (!pattern.test(row.period) || map.has(row.period))
        throw new Error('Invalid or duplicate return period');
      map.set(row.period, { ...row, return: points ? null : row.return });
    }
    return map;
  };
  return {
    run,
    result_hash: resultHash,
    pnl_unit: points ? ('points' as const) : ('currency' as const),
    metrics_source:
      result.metrics_source ?? (native ? 'TqSim/TqReport' : 'quant_sdk'),
    metrics,
    metric_notes: metricNotes,
    coverage,
    yearly: periods(result.yearly_returns, /^\d{4}$/),
    monthly: periods(result.monthly_returns, /^\d{4}-(0[1-9]|1[0-2])$/),
  };
}

type Entry = ReturnType<typeof prepareBacktestComparison>;
type Metric = {
  label: string;
  ratio?: boolean;
  direction?: 'higher' | 'lower';
};
const metricDefinitions: Record<string, Metric> = {
  total_pnl: { label: '总收益', direction: 'higher' },
  total_return: { label: '收益率', ratio: true, direction: 'higher' },
  annual_return: { label: '年化收益率', ratio: true, direction: 'higher' },
  max_drawdown: { label: '最大回撤', ratio: true, direction: 'lower' },
  sharpe: { label: '夏普比率', direction: 'higher' },
  sortino: { label: '索提诺比率', direction: 'higher' },
  calmar: { label: '卡玛比率', direction: 'higher' },
  profit_factor: { label: '盈利因子 PF', direction: 'higher' },
  profit_loss_ratio: { label: '盈亏额比例（天勤）', direction: 'higher' },
  win_rate: { label: '胜率', ratio: true, direction: 'higher' },
  trade_count: { label: '交易数' },
  final_equity: { label: '最终权益' },
  commission: { label: '手续费' },
  benchmark_return: { label: '基准收益率', ratio: true },
  benchmark_annual_return: { label: '基准年化收益率', ratio: true },
  total_points: { label: '累计收益（点）', direction: 'higher' },
  realized_points: { label: '已实现收益（点）', direction: 'higher' },
  unrealized_points: { label: '未平仓净收益（点）' },
  max_drawdown_points: { label: '最大回撤（点）', direction: 'lower' },
  average_trade_points: { label: '平均每笔收益（点）', direction: 'higher' },
  benchmark_points: { label: '基准涨跌（点）' },
};

function settings(entry: Entry): Record<string, unknown> {
  const { run, pnl_unit, metrics_source } = entry;
  const c = run.config;
  const native = c.backtest_engine === 'tqsdk';
  const points = pnl_unit === 'points';
  return {
    engine: run.engine,
    backtest_engine: c.backtest_engine ?? 'builtin',
    metrics_source,
    symbol: c.symbol,
    duration: c.duration,
    start: c.start,
    end: c.end,
    execution_model: c.execution_model ?? 'actual_contract',
    slippage_ticks: c.slippage_ticks,
    benchmark_symbol: c.benchmark_symbol,
    ...(!points
      ? { initial_cash: c.initial_cash }
      : { point_cost: c.point_cost ?? 0 }),
    ...(native
      ? { tq_options: c.tq_options ?? {} }
      : {
          calendar: c.calendar ?? {},
          ...(!points
            ? {
                annualization: c.annualization,
                risk_free_rate: c.risk_free_rate,
                participation_rate: c.participation_rate,
                rules: {
                  ...c.rules,
                  fees: {
                    ...c.rules.fees,
                    mode: c.rules.fees.mode ?? 'combined',
                  },
                },
              }
            : {}),
        }),
  };
}

const number = (value: number) =>
  value.toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
const formatted = (value: number | null, ratio = false) =>
  value === null
    ? '未定义/无数据'
    : `${number(ratio ? value * 100 : value)}${ratio ? '%' : ''}`;
const difference = (value: number | null, baseline: number | null) =>
  value === null || baseline === null ? null : value - baseline;
const deltaText = (value: number, unit: string) =>
  `${value > 0 ? '+' : ''}${number(value)}${unit}`;
const label = (entry: Entry) =>
  entry.run.version_name ?? `V${entry.run.version_number}`;
function coverageView(value: Coverage | undefined) {
  return value
    ? {
        first_time: value.first_time,
        last_time: value.last_time,
        first_trading_day: value.trading_days[0],
        last_trading_day: value.trading_days.at(-1),
        trading_day_count: value.trading_days.length,
        observations: value.observations,
      }
    : null;
}
function leaders(
  values: { run_id: string; value: number | null }[],
  direction: 'higher' | 'lower',
) {
  if (values.some((item) => item.value === null)) return [];
  const best = (direction === 'higher' ? Math.max : Math.min)(
    ...values.map((item) => item.value!),
  );
  return values
    .filter((item) => item.value === best)
    .map((item) => item.run_id);
}

export function compareBacktests(entries: Entry[]) {
  validateComparisonRuns(entries.map((entry) => entry.run));
  const baseline = entries[0];
  if (entries.some((entry) => entry.pnl_unit !== baseline.pnl_unit))
    throw new StrategyError('BACKTEST_COMPARISON_UNIT_MISMATCH', 400);
  const baselineSettings = settings(baseline);
  const differences = entries.slice(1).flatMap((entry) =>
    Object.entries(settings(entry)).flatMap(([field, value]) =>
      isDeepStrictEqual(value, baselineSettings[field])
        ? []
        : [
            {
              run_id: entry.run.id,
              field,
              baseline: baselineSettings[field],
              value,
            },
          ],
    ),
  );
  const sameSettings = differences.length === 0;
  const sameCoverage = (period: string) =>
    !!baseline.coverage.get(period) &&
    entries.every((entry) =>
      isDeepStrictEqual(
        entry.coverage.get(period),
        baseline.coverage.get(period),
      ),
    );
  const comparable = sameSettings && sameCoverage('all');
  const warnings: string[] = [];
  if (!sameSettings)
    warnings.push(
      `回测设置或指标口径不同（${[...new Set(differences.map((item) => item.field))].join('、')}），差值仅作描述，不据此判定版本优劣。`,
    );
  if (!sameCoverage('all'))
    warnings.push(
      '实际权益观测范围、交易日或采样数量不同/缺失，整体指标不作同条件排名；请核对行情覆盖。',
    );
  if (
    entries.some(
      (entry) =>
        !isDeepStrictEqual(
          entry.run.config.parameters,
          baseline.run.config.parameters,
        ),
    )
  )
    warnings.push(
      '各版本实际参数不同，对比包含代码及参数的共同影响；实际参数随各回测配置返回。',
    );
  for (const entry of entries) {
    if (entry.metrics.trade_count === 0)
      warnings.push(`${label(entry)} 没有已平仓交易，完成回测不代表策略有效。`);
  }
  const currency = baseline.pnl_unit === 'points' ? '点' : '元';
  const keys = [
    ...new Set(entries.flatMap((entry) => Object.keys(entry.metrics))),
  ];
  const metrics = keys.map((key) => {
    const definition = metricDefinitions[key] ?? { label: key };
    const base = baseline.metrics[key] ?? null;
    const values = entries.map((entry) => ({
      run_id: entry.run.id,
      value: entry.metrics[key] ?? null,
      delta_from_baseline: difference(entry.metrics[key] ?? null, base),
    }));
    const best =
      comparable && definition.direction
        ? leaders(values, definition.direction)
        : [];
    const unit = definition.ratio
      ? 'ratio'
      : key.endsWith('_points')
        ? 'points'
        : ['total_pnl', 'final_equity', 'commission'].includes(key)
          ? baseline.pnl_unit
          : 'number';
    const description = `${definition.label}：${values.map((item, index) => `${label(entries[index])} ${formatted(item.value, definition.ratio)}${unit === 'currency' ? '元' : unit === 'points' && item.value !== null ? '点' : ''}${index && item.delta_from_baseline !== null ? `（较${label(baseline)} ${deltaText(item.delta_from_baseline * (definition.ratio ? 100 : 1), definition.ratio ? '个百分点' : unit === 'points' ? '点' : unit === 'currency' ? '元' : '')}）` : ''}`).join('；')}。${
      best.length
        ? `${entries
            .filter((entry) => best.includes(entry.run.id))
            .map(label)
            .join(
              '、',
            )}${best.length > 1 ? '并列' : ''}${definition.direction === 'lower' ? '最低' : '最高'}。`
        : ''
    }`;
    return {
      metric: key,
      label: definition.label,
      unit,
      direction: definition.direction ?? null,
      values,
      best_run_ids: best,
      description,
    };
  });
  const periods = (kind: 'yearly' | 'monthly') => {
    const all = [
      ...new Set(entries.flatMap((entry) => [...entry[kind].keys()])),
    ].sort();
    return all.map((period) => {
      const base = baseline[kind].get(period);
      const values = entries.map((entry) => {
        const value = entry[kind].get(period);
        return {
          run_id: entry.run.id,
          present: !!value,
          return: value?.return ?? null,
          pnl: value?.pnl ?? null,
          return_delta_from_baseline: difference(
            value?.return ?? null,
            base?.return ?? null,
          ),
          pnl_delta_from_baseline: difference(
            value?.pnl ?? null,
            base?.pnl ?? null,
          ),
          coverage: coverageView(entry.coverage.get(period)),
        };
      });
      const periodComparable =
        sameSettings &&
        values.every((value) => value.present) &&
        sameCoverage(period);
      const best = periodComparable
        ? leaders(
            values.map((value) => ({
              run_id: value.run_id,
              value: baseline.pnl_unit === 'points' ? value.pnl : value.return,
            })),
            'higher',
          )
        : [];
      const description = `${period}：${values
        .map((value, index) => {
          if (!value.present) return `${label(entries[index])} 无数据`;
          const delta =
            baseline.pnl_unit === 'points'
              ? value.pnl_delta_from_baseline
              : value.return_delta_from_baseline;
          return `${label(entries[index])} 收益 ${formatted(value.pnl)}${currency}${baseline.pnl_unit === 'currency' ? `，收益率 ${formatted(value.return, true)}` : ''}${index && delta !== null ? `（较${label(baseline)} ${deltaText(delta * (baseline.pnl_unit === 'points' ? 1 : 100), baseline.pnl_unit === 'points' ? '点' : '个百分点')}）` : ''}`;
        })
        .join('；')}。${
        best.length
          ? `${entries
              .filter((entry) => best.includes(entry.run.id))
              .map(label)
              .join(
                '、',
              )}${best.length > 1 ? '并列' : ''}收益${baseline.pnl_unit === 'currency' ? '率' : ''}最高。`
          : !periodComparable
            ? '设置、覆盖或数据不齐，不作同条件排名。'
            : '收益率未定义，不作排名。'
      }`;
      return {
        period,
        comparable: periodComparable,
        values,
        best_run_ids: best,
        description,
      };
    });
  };
  const yearly = periods('yearly');
  const monthly = periods('monthly');
  if (
    yearly.some((row) => row.values.some((value) => !value.present)) ||
    monthly.some((row) => row.values.some((value) => !value.present))
  )
    warnings.push(
      '部分年度或月份缺少某版本数据，缺失值保留为 null，不按零收益补齐。',
    );
  const summary = `同一策略的 ${entries.map(label).join('、')} 回测对比，以${label(baseline)}为基准，收益单位为${currency}。${comparable ? '已记录的回测设置及权益观测覆盖一致。' : '存在设置或数据覆盖差异，请结合差异说明阅读。'}年度、月度按原始报告的交易日归属对齐，首尾期间可能只覆盖部分交易日；保留原始收益，不补齐或折算完整年/月。`;
  return {
    strategy_id: baseline.run.strategy_id,
    baseline_run_id: baseline.run.id,
    pnl_unit: baseline.pnl_unit,
    comparable,
    config_differences: differences,
    warnings,
    runs: entries.map((entry) => ({
      run_id: entry.run.id,
      version_id: entry.run.version_id,
      version_number: entry.run.version_number,
      version_name: entry.run.version_name,
      source_hash: entry.run.source_hash,
      result_hash: entry.result_hash,
      config: entry.run.config,
      metrics_source: entry.metrics_source,
      metric_notes: entry.metric_notes,
      coverage: coverageView(entry.coverage.get('all')),
    })),
    metrics,
    yearly,
    monthly,
    summary,
    description: [
      summary,
      ...warnings,
      '整体指标：',
      ...metrics.map((row) => row.description),
      '年度表现：',
      ...(yearly.length
        ? yearly.map((row) => row.description)
        : ['无年度数据。']),
      '月度表现：',
      ...(monthly.length
        ? monthly.map((row) => row.description)
        : ['无月度数据。']),
    ].join('\n'),
  };
}
