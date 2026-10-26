import { z } from 'zod';
import { OPTIMIZATION_METRICS } from '../../optimization-types.js';

const distribution = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('int'),
      low: z.number().int().safe(),
      high: z.number().int().safe(),
      step: z.number().int().positive().optional(),
      log: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('float'),
      low: z.number().finite(),
      high: z.number().finite(),
      step: z.number().finite().positive().optional(),
      log: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('categorical'),
      choices: z
        .array(
          z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
        )
        .min(1)
        .max(100),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.type === 'categorical') return;
    if (value.high < value.low)
      ctx.addIssue({ code: 'custom', message: '上限不能小于下限' });
    if (
      value.log &&
      (value.low <= 0 ||
        (value.step !== undefined &&
          (value.type === 'float' || value.step !== 1)))
    )
      ctx.addIssue({
        code: 'custom',
        message: '对数搜索需要正数范围，不能同时设置步长（整数步长 1 除外）',
      });
  });

export const optimizationSchema = z.object({
  search_space: z
    .record(z.string().min(1).max(100), distribution)
    .refine(
      (space) =>
        Object.keys(space).length > 0 && Object.keys(space).length <= 30,
      '请设置 1–30 个搜索参数',
    )
    .refine(
      (space) =>
        !Object.keys(space).some((key) =>
          [
            'symbol',
            'duration',
            'execution_model',
            '__proto__',
            'constructor',
            'prototype',
          ].includes(key),
        ),
      '行情与成交模式不能作为策略搜索参数',
    ),
  metric: z
    .enum(
      Object.keys(OPTIMIZATION_METRICS) as [
        keyof typeof OPTIMIZATION_METRICS,
        ...Array<keyof typeof OPTIMIZATION_METRICS>,
      ],
    )
    .default('sharpe'),
  // Bound server work; one optimization occupies one existing queue slot.
  n_trials: z.number().int().min(1).max(200).default(30),
  timeout_seconds: z.number().int().min(1).max(3600).default(600),
  seed: z.number().int().min(0).max(4294967295).default(42),
  min_trades: z.number().int().min(1).default(1),
  validation_start: z.number().int().positive().optional(),
});
