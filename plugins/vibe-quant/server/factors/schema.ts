import { z } from 'zod';

export class FactorError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429 = 400,
  ) {
    super(message);
  }
}

export const factorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(''),
  enabled: z.boolean().default(true),
  source: z.string().min(1).max(60_000),
  parameters: z.record(z.string(), z.unknown()).default({}),
  group_id: z.uuid().optional(),
});

export const factorGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  parent_id: z.uuid().nullable().default(null),
  revision: z.number().int().nonnegative(),
});

export const analysisSchema = z
  .object({
    version_id: z.uuid().nullable().default(null),
    symbols: z
      .array(z.string().regex(/^[A-Za-z0-9_.@-]{1,100}$/))
      .min(3)
      .max(50)
      .refine((items) => new Set(items).size === items.length, '合约不能重复'),
    start: z.iso.date(),
    end: z.iso.date(),
    holding_days: z.number().int().min(1).max(60).default(5),
    groups: z.number().int().min(2).max(10).default(5),
    direction: z.union([z.literal(1), z.literal(-1)]).default(1),
  })
  .refine(
    (v) =>
      v.end > v.start &&
      Date.parse(v.end) - Date.parse(v.start) <= 10 * 366 * 86400_000,
    '分析区间须为递增日期，最多十年',
  )
  .refine((v) => v.symbols.length >= v.groups, '合约数量不能少于分组数');

export const factorId = (value: string) => {
  if (!z.uuid().safeParse(value).success)
    throw new FactorError('记录不存在', 404);
  return value;
};
