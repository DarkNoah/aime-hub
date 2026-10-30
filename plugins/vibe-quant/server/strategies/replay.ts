import { z } from 'zod';
import {
  BAR_JUMP_RADIUS,
  BAR_PAGE_SIZE,
  DURATIONS,
  MONTH_DURATION,
  type Bar,
} from '../../shared.js';
import type { TradeRecord, TradeReplay } from '../../strategy-types.js';
import { tradeExitAnchor } from '../../strategy-types.js';
import { periodStart } from '../bar-periods.js';

const timestamp = z.coerce.number().int().positive().safe();
export const replayQuerySchema = z
  .object({
    duration: z.coerce
      .number()
      .refine((value) => DURATIONS.some((item) => item === value))
      .default(60),
    at: z.enum(['entry', 'exit', 'latest']).default('entry'),
    around: timestamp.optional(),
    before: timestamp.optional(),
    after: timestamp.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(BAR_PAGE_SIZE),
    intraday: z.enum(['true', 'false']).default('false'),
  })
  .refine(
    (value) =>
      [value.around, value.before, value.after].filter((v) => v !== undefined)
        .length <= 1,
  )
  .refine((value) => value.intraday !== 'true' || value.duration === 60);

type SnapshotBar = Bar & { trading_day: string; is_final?: boolean };
export interface ReplayDataset {
  instruments: { symbol: string; price_tick: number }[];
  events: { type: string; payload: SnapshotBar }[];
}

function bucket(bar: SnapshotBar, duration: number) {
  // Futures night sessions belong to the following trading day, including across months.
  if (duration === 86400 || duration === MONTH_DURATION) {
    const day =
      duration === MONTH_DURATION
        ? `${bar.trading_day.slice(0, 7)}-01`
        : bar.trading_day;
    return Date.parse(`${day}T00:00:00+08:00`) / 1000;
  }
  return periodStart(bar.time, duration);
}
function nearest(bars: Bar[], time: number) {
  let index = 0;
  for (let i = 1; i < bars.length; i++) {
    if (Math.abs(bars[i].time - time) < Math.abs(bars[index].time - time))
      index = i;
  }
  return index;
}

/** Aggregate the immutable execution candles before slicing, never consult current market data. */
export function replayWindow(
  dataset: ReplayDataset,
  trade: TradeRecord,
  query: z.infer<typeof replayQuerySchema>,
): Omit<TradeReplay, 'snapshotHash'> {
  const exitTime = tradeExitAnchor(trade);
  const { anchors, ...window } = snapshotWindow(
    dataset,
    trade.symbol,
    query,
    query.at === 'exit' ? (exitTime ?? trade.entry_time) : trade.entry_time,
  );
  return {
    ...window,
    trade,
    markerTimes: {
      entry: anchors.get(Math.floor(trade.entry_time / 60) * 60) ?? null,
      exit:
        exitTime === null
          ? null
          : (anchors.get(Math.floor(exitTime / 60) * 60) ?? null),
    },
  };
}

function snapshotWindow(
  dataset: ReplayDataset,
  symbol: string,
  query: z.infer<typeof replayQuerySchema>,
  anchorTime?: number,
) {
  const minutes = [
    ...new Map(
      dataset.events
        .filter(
          (event) =>
            event.type === 'bar' &&
            event.payload.symbol === symbol &&
            event.payload.duration === 60 &&
            event.payload.is_final !== false,
        )
        .map(({ payload }) => [payload.time, payload] as const),
    ).values(),
  ].sort((a, b) => a.time - b.time);
  const { duration } = query;
  const time =
    query.around ??
    (query.at === 'latest'
      ? (minutes.at(-1)?.time ?? 0)
      : (anchorTime ?? minutes[0]?.time ?? 0));
  const day = minutes[nearest(minutes, time)]?.trading_day;
  const selected =
    query.intraday === 'true'
      ? minutes.filter((bar) => bar.trading_day === day)
      : minutes;
  const groups = new Map<number, Bar>();
  const anchors = new Map<number, number>();
  for (const bar of selected) {
    const start = bucket(bar, duration);
    anchors.set(bar.time, start);
    const old = groups.get(start);
    if (old) {
      old.high = Math.max(old.high, bar.high);
      old.low = Math.min(old.low, bar.low);
      old.close = bar.close;
      old.volume += bar.volume;
      old.amount =
        old.amount != null && bar.amount != null
          ? old.amount + bar.amount
          : null;
    } else {
      const { symbol, open, high, low, close, volume, amount } = bar;
      groups.set(start, {
        symbol,
        time: start,
        duration,
        open,
        high,
        low,
        close,
        volume,
        amount,
      });
    }
  }
  const bars = [...groups.values()].sort((a, b) => a.time - b.time);
  const reference = selected[nearest(selected, time)];
  const targetTime = reference ? bucket(reference, duration) : null;
  const index = Math.max(
    0,
    bars.findIndex((bar) => bar.time === targetTime),
  );
  let from = Math.max(0, index - BAR_JUMP_RADIUS);
  let to = Math.min(bars.length, index + BAR_JUMP_RADIUS + 1);
  if (query.intraday === 'true') {
    from = 0;
    to = bars.length;
  } else if (query.before !== undefined) {
    to = bars.findIndex((bar) => bar.time >= query.before!);
    if (to < 0) to = bars.length;
    from = Math.max(0, to - query.limit);
  } else if (query.after !== undefined) {
    from = bars.findIndex((bar) => bar.time > query.after!);
    if (from < 0) from = bars.length;
    to = Math.min(bars.length, from + query.limit);
  } else if (query.at === 'latest' && query.around === undefined) {
    to = bars.length;
    from = Math.max(0, to - query.limit);
  }
  return {
    bars: bars.slice(from, to),
    duration,
    targetTime:
      query.at === 'latest' && query.around === undefined ? null : targetTime,
    priceTick:
      dataset.instruments.find((item) => item.symbol === symbol)?.price_tick ??
      0.01,
    hasBefore: from > 0,
    hasAfter: to < bars.length,
    range: minutes.length
      ? { start: minutes[0].time, end: minutes.at(-1)!.time + 60 }
      : null,
    anchors,
  };
}

/** Adapt a frozen TqBacktest dataset to the existing market-chart paging API. */
export function nativeMarketWindow(
  dataset: ReplayDataset,
  trade: Pick<TradeRecord, 'symbol'>,
  query: {
    duration: number;
    limit: number;
    around?: number;
    before?: number;
    after?: number;
  },
  sessionAnchors = false,
) {
  const window = snapshotWindow(dataset, trade.symbol, {
    ...query,
    at: query.around === undefined ? 'latest' : 'entry',
    intraday: 'false',
  });
  if (sessionAnchors && query.duration === 86400) {
    // The intraday UI uses daily anchors to bound minute queries. Anchor a
    // futures day at its first observed session, including the prior night.
    const starts = new Map<number, number>();
    for (const event of dataset.events) {
      const bar = event.payload;
      if (
        event.type !== 'bar' ||
        bar.symbol !== trade.symbol ||
        bar.duration !== 60 ||
        bar.is_final === false
      )
        continue;
      const key = bucket(bar, 86400);
      starts.set(key, Math.min(starts.get(key) ?? Infinity, bar.time));
    }
    window.bars = window.bars.map((bar) => ({
      ...bar,
      time: starts.get(bar.time) ?? bar.time,
    }));
    if (window.targetTime !== null)
      window.targetTime = starts.get(window.targetTime) ?? window.targetTime;
  }
  return query.around === undefined
    ? window.bars
    : {
        bars: window.bars,
        targetTime: window.targetTime,
        priceTick: window.priceTick,
      };
}
