import { createTool } from '@mastra/core/tools';
import { PluginTool, type PluginContext } from '@app/plugin-sdk/server';
import { z } from 'zod';
import { DURATIONS } from '../../shared.js';
import { derivedPeriod, nextPeriodStart } from '../../server/bar-periods.js';
import { symbol } from '../../server/strategies/schema.js';
import { quantToolContext, type QuantDependencies } from './context.js';

const inputSchema = z.object({
  symbol: z.string().describe('完整标的代码，可先用 instrument_search 查询'),
  duration: z
    .number()
    .default(60)
    .describe(
      'K 线周期秒数：60、180、300、900、1800、3600、86400 或 2592000（月线）',
    ),
  start_date: z
    .string()
    .optional()
    .describe('北京时间起始日期 YYYY-MM-DD；只查一天时仅填此项'),
  end_date: z
    .string()
    .optional()
    .describe(
      '北京时间结束日期 YYYY-MM-DD，包含当天；省略时与 start_date 相同',
    ),
  order: z
    .enum(['asc', 'desc'])
    .default('desc')
    .describe('asc 从早到晚，desc 从晚到早'),
  cursor: z
    .number()
    .optional()
    .describe('上一页返回的 next_cursor；翻页时保持其他查询条件不变'),
  limit: z.number().default(100).describe('每页条数，1–500'),
});

// Validate in execute, keeping the model-facing input schema simple.
const querySchema = inputSchema
  .extend({
    symbol,
    duration: z
      .number()
      .refine(
        (value) => DURATIONS.some((item) => item === value),
        '不支持的 K 线周期',
      ),
    start_date: z.iso.date().optional(),
    end_date: z.iso.date().optional(),
    cursor: z.number().int().positive().safe().optional(),
    limit: z.number().int().min(1).max(500),
  })
  .refine(
    (value) =>
      !value.start_date ||
      !value.end_date ||
      value.start_date <= value.end_date,
    {
      path: ['end_date'],
      message: '结束日期不能早于开始日期',
    },
  );

export class MarketBarsTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    super(
      createTool({
        id: 'plugin_vibe_quant_market_bars',
        title: '查询 K 线行情',
        description:
          '按标的、周期、北京时间日期范围分页查询当前引擎已采集的 K 线（OHLC、成交量和可用的成交额）。默认最近 100 根；只查某天填 start_date，跨日再填 end_date。按 next_cursor 翻页，保持标的、日期、周期和排序不变。日期按 K 线起始时间筛选，不代表期货交易日；不会自动下载或补齐缺失行情。',
        inputSchema,
        execute: (input, execution) =>
          run(execution, async ({ market, config }, _actor, signal) => {
            const query = querySchema.parse({
              ...input,
              symbol: input.symbol.trim(),
            });
            const start = query.start_date
              ? Date.parse(`${query.start_date}T00:00:00+08:00`) / 1000
              : undefined;
            const endDate = query.end_date ?? query.start_date;
            const end = endDate
              ? Date.parse(`${endDate}T00:00:00+08:00`) / 1000 + 86400
              : undefined;
            if (
              (start !== undefined && start <= 0) ||
              (end !== undefined && end <= 0)
            )
              return {
                error: 'INVALID_DATE',
                message: '请选择 1970-01-02 或之后的日期。',
              };
            const forward = query.order === 'asc';
            let after = start === undefined ? undefined : start - 1;
            // Include complete derived candles whose start belongs to the date range.
            let before =
              end === undefined
                ? undefined
                : derivedPeriod(query.duration)
                  ? nextPeriodStart(end - 1, query.duration)
                  : end;
            if (query.cursor !== undefined) {
              if (forward) after = Math.max(after ?? 0, query.cursor);
              else before = Math.min(before ?? Infinity, query.cursor);
            }
            const rows =
              before !== undefined && after !== undefined && after >= before
                ? []
                : await market.bars(
                    config.engine,
                    query.symbol,
                    query.duration,
                    {
                      after,
                      before,
                      order: query.order,
                      limit: query.limit + 1,
                    },
                  );
            signal?.throwIfAborted();
            const ordered = forward ? rows : [...rows].reverse();
            const bars = ordered.slice(0, query.limit);
            const hasMore = ordered.length > query.limit;
            return {
              engine: config.engine,
              symbol: query.symbol,
              duration: query.duration,
              timezone: 'Asia/Shanghai',
              start_date: query.start_date ?? null,
              end_date: endDate ?? null,
              order: query.order,
              bars,
              count: bars.length,
              has_more: hasMore,
              next_cursor: hasMore ? bars.at(-1)!.time : null,
              data_policy:
                '已采集及当前缓存行情，可能存在缺口或尚未收盘的 K 线；time 为 K 线起始时刻的 UTC epoch 秒，成交额缺失时不推算。',
            };
          }),
      }),
    );
  }
}
