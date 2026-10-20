import { z } from 'zod';
import type { PluginConfig } from '@app/plugin-sdk';

const schema = z
  .object({
    engine: z.enum(['tqsdk', 'tushare', 'tdx']),
    clickhouseUrl: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    clickhouseDatabase: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/),
    clickhouseUser: z.string().min(1),
    clickhousePassword: z.string().min(1),
    clickhouseReadOnly: z.boolean().default(false),
    tqUser: z.string().default(''),
    tqPassword: z.string().default(''),
    tushareToken: z.string().default(''),
    tdxServers: z.string().default(''),
    beforeOpenMinutes: z.number().int().min(0).max(120),
    afterCloseMinutes: z.number().int().min(0).max(120),
    flushSeconds: z.number().int().min(1).max(60),
    pollSeconds: z.number().int().min(2).max(300),
    historyBars: z.number().int().min(100).max(8000),
    historyTicks: z.number().int().min(1).max(10000).default(10000),
    maxSubscriptions: z.number().int().min(1).max(500),
  })
  .superRefine((value, ctx) => {
    if (value.engine === 'tdx') {
      const lines = value.tdxServers
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (
        !lines.length ||
        lines.length > 32 ||
        lines.some((line) => {
          const parts = line.split(':');
          return (
            parts.length !== 2 ||
            !z.ipv4().safeParse(parts[0]).success ||
            !/^\d{1,5}$/.test(parts[1]) ||
            Number(parts[1]) < 1 ||
            Number(parts[1]) > 65535
          );
        })
      )
        ctx.addIssue({
          code: 'custom',
          path: ['tdxServers'],
          message: '请填写 1–32 行 IPv4:端口，端口范围 1–65535',
        });
    }
    const missing =
      value.engine === 'tqsdk'
        ? !value.tqUser || !value.tqPassword
        : value.engine === 'tushare'
          ? !value.tushareToken
          : false;
    if (missing)
      ctx.addIssue({
        code: 'custom',
        message: `${value.engine} 数据源参数未填写完整`,
      });
  });
export type QuantConfig = z.infer<typeof schema>;
export function parseConfig(config: PluginConfig): QuantConfig {
  const result = schema.safeParse(config);
  if (!result.success)
    throw new Error(
      `Vibe Quant 参数无效：${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  return result.data;
}
