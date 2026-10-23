import { z } from 'zod';
import { DURATIONS, type Engine } from '../shared.js';
import type { MarketStore } from './clickhouse.js';

const timestamp = z.coerce.number().int().positive().safe().optional();
export const marketBarsQuery = z
  .object({
    duration: z.coerce
      .number()
      .refine((value) => DURATIONS.some((d) => d === value))
      .default(60),
    before: timestamp,
    after: timestamp,
    around: timestamp,
    limit: z.coerce.number().int().min(1).max(1000).default(1000),
  })
  .refine(
    (value) =>
      [value.before, value.after, value.around].filter((v) => v !== undefined)
        .length <= 1,
  );

/** Quotes and trade navigation read the same unbounded market history, one window/page at a time. */
export function readMarketBars(
  store: MarketStore,
  engine: Engine,
  symbol: string,
  query: z.infer<typeof marketBarsQuery>,
) {
  const { duration, before, after, around, limit } = query;
  return around === undefined
    ? store.bars(engine, symbol, duration, { before, after, limit })
    : store.barsAround(engine, symbol, duration, around);
}
