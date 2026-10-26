import { z } from 'zod';
import { MAX_BACKTEST_SECONDS } from './limits.js';
import { optimizationSchema } from './optimization.js';
import { strategyNotificationsSchema } from '../../strategy-notifications.js';

export const symbol = z.string().regex(/^[A-Za-z0-9_.@-]{1,100}$/);
export const strategyStatusSchema = z.enum(['active', 'archived', 'deleted']);
const nonnegative = z.number().finite().nonnegative();
export const draftSchema = z.object({
  source: z.string().min(1).max(60_000),
  parameters: z.record(z.string(), z.unknown()),
});
export const strategySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(''),
  enabled: z.boolean().default(true),
  // Omission preserves existing preferences for older clients and Agent edits.
  notifications: strategyNotificationsSchema.optional(),
  draft: draftSchema,
});
export const backtestSchema = z
  .object({
    optimization: optimizationSchema.optional(),
    version_id: z.uuid(),
    symbol,
    execution_model: z.enum(['actual_contract', 'continuous_price']).optional(),
    duration: z.union([
      z.literal(60),
      z.literal(180),
      z.literal(300),
      z.literal(900),
      z.literal(1800),
      z.literal(3600),
      z.literal(86400),
    ]),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    initial_cash: z.number().finite().positive(),
    slippage_ticks: nonnegative,
    participation_rate: z.number().positive().max(1),
    annualization: z.number().int().positive().max(366),
    risk_free_rate: z.number().finite(),
    benchmark_symbol: symbol.nullable(),
    parameters: z.record(z.string(), z.unknown()),
    rules: z.object({
      multiplier: z.number().finite().positive(),
      margin_rate: z.number().positive().max(1),
      lot_size: z.number().int().positive(),
      t_plus_one: z.boolean(),
      fees: z.object({
        mode: z.enum(['fixed', 'rate', 'combined']).optional(),
        per_unit: nonnegative,
        rate: nonnegative,
        minimum: nonnegative,
        close_today_per_unit: nonnegative.nullable(),
        close_today_rate: nonnegative.nullable(),
        sell_tax_rate: nonnegative,
      }),
    }),
    calendar: z
      .record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.boolean())
      .optional(),
  })
  .refine((v) => v.end > v.start && v.end - v.start <= MAX_BACKTEST_SECONDS, {
    message: '结束时间须晚于开始时间，跨度最多十年',
    path: ['end'],
  })
  .refine(
    (v) =>
      v.optimization?.validation_start === undefined ||
      (v.optimization.validation_start > v.start &&
        v.optimization.validation_start < v.end),
    {
      message: '验证开始时间必须位于回测区间内',
      path: ['optimization', 'validation_start'],
    },
  )
  .refine(
    (v) =>
      v.execution_model !== 'continuous_price' || v.symbol.startsWith('KQ.m@'),
    '主连价格模拟仅支持主连标的',
  );

export class StrategyError extends Error {
  constructor(
    public code: string,
    public status: 400 | 403 | 404 | 409 | 429 | 503 = 400,
  ) {
    super(code);
  }
}

/** Keep HTTP forms and Agent submissions on the same validation path. */
export function parseBacktestConfig(input: unknown) {
  const parsed = backtestSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  throw new StrategyError(
    field === 'start' || field === 'end'
      ? 'INVALID_BACKTEST_TIME_RANGE'
      : field === 'optimization'
        ? 'INVALID_OPTIMIZATION_CONFIG'
        : 'INVALID_BACKTEST_CONFIG',
  );
}
