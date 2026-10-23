import { z } from 'zod';
import type { Engine } from '../shared.js';
import {
  buildPriceProfile,
  PROFILE_RANGES,
  PROFILE_SOURCE,
  PROFILE_DAY,
  PROFILE_LIMIT,
  profileRangeStart,
  type VolumeProfileData,
} from '../volume-profile.js';
import { ClickHouseClient, ClickHouseError } from './clickhouse-client.js';
import { readContractSpans } from './contract-spans.js';
import type { TradeReader } from './trades/service.js';
import { tradeInstrument } from './trades/symbols.js';
import {
  DAY,
  TradeDataError,
  dateAt,
  midnight,
  type TradeDay,
  type TradePrint,
} from './trades/types.js';

export const volumeProfileQuery = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().positive(),
    range: z.enum(
      Object.keys(PROFILE_RANGES) as [
        keyof typeof PROFILE_RANGES,
        ...Array<keyof typeof PROFILE_RANGES>,
      ],
    ),
    rowSize: z.coerce.number().int().min(2).max(200).default(30),
    valueAreaVolume: z.coerce.number().min(1).max(100).default(70),
  })
  .refine(
    (q) =>
      q.to > q.from &&
      q.to - q.from <= 60 * PROFILE_DAY &&
      q.to - q.from <= PROFILE_LIMIT * PROFILE_RANGES[q.range] &&
      profileRangeStart(q.from, PROFILE_RANGES[q.range]) === q.from,
  );
export type VolumeProfileQuery = z.infer<typeof volumeProfileQuery>;
/** All civil days touched by a range must have complete source pagination.
 * A current-day snapshot covers only its observed prefix, never later time.
 */
export function profilesFromTrades(
  days: readonly TradeDay[],
  query: VolumeProfileQuery,
): VolumeProfileData {
  const result: VolumeProfileData = {
    segments: [],
    source: PROFILE_SOURCE,
    warnings: [],
  };
  const span = PROFILE_RANGES[query.range];
  const byDate = new Map(days.map((day) => [day.date, day]));
  const groups = new Map<number, TradePrint[]>();
  for (const day of days)
    for (const trade of day.trades) {
      if (trade.time < query.from || trade.time >= query.to) continue;
      const start = profileRangeStart(trade.time, span);
      const group = groups.get(start) ?? [];
      group.push(trade);
      groups.set(start, group);
    }
  let skipped = 0;
  for (let start = query.from; start < query.to; start += span) {
    const end = Math.min(start + span, query.to);
    let covered = true;
    for (let at = midnight(dateAt(start)); at < end; at += DAY) {
      const day = byDate.get(dateAt(at));
      if (!day || (!day.isFinal && day.fetchedAt < Math.min(end, at + DAY)))
        covered = false;
    }
    if (!covered) {
      skipped++;
      continue;
    }
    const profile = buildPriceProfile(
      groups.get(start) ?? [],
      query.rowSize,
      query.valueAreaVolume,
    );
    if (profile) result.segments.push({ start, end, profile });
  }
  if (skipped)
    result.warnings.push(`${skipped} 个区间的通达信分笔尚未齐全，暂不绘制。`);
  if (!result.segments.length && !skipped)
    result.warnings.push('所选范围暂无可用的通达信分笔成交。');
  return result;
}

async function contractProfile(
  symbol: string,
  query: VolumeProfileQuery,
  trades: TradeReader,
  signal: AbortSignal,
) {
  tradeInstrument(symbol);
  const days: TradeDay[] = [],
    warnings: string[] = [];
  let count = 0;
  for (let at = midnight(dateAt(query.from)); at < query.to; at += DAY) {
    signal.throwIfAborted();
    try {
      const day = await trades.readDay(symbol, dateAt(at), signal);
      count += day.trades.length;
      if (count > 250_000)
        return {
          segments: [],
          source: PROFILE_SOURCE,
          warnings: ['分笔数量超过单次计算上限，请缩小图表范围。'],
        };
      days.push(day);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ClickHouseError) throw error;
      warnings.push(
        error instanceof TradeDataError
          ? error.message
          : `${dateAt(at)} 通达信分笔读取失败，请稍后重试。`,
      );
      // Repeated source failures should not fan out across sixty historical dates.
      if (warnings.length >= 3) break;
    }
  }
  const result = profilesFromTrades(days, query);
  result.warnings = [...new Set([...warnings, ...result.warnings])];
  return result;
}

export async function readVolumeProfile(
  client: ClickHouseClient,
  _engine: Engine,
  symbol: string,
  query: VolumeProfileQuery,
  trades: TradeReader,
  signal: AbortSignal = new AbortController().signal,
): Promise<VolumeProfileData> {
  const empty = (message: string): VolumeProfileData => ({
    segments: [],
    source: PROFILE_SOURCE,
    warnings: [message],
  });
  const timeout = AbortSignal.timeout(55_000);
  const sourceSignal = AbortSignal.any([signal, timeout]);
  if (symbol.startsWith('KQ.') && !symbol.startsWith('KQ.m@'))
    return empty('加权指数没有单一成交明细，无法计算成交量分布。');
  try {
    sourceSignal.throwIfAborted();
    if (!symbol.startsWith('KQ.m@'))
      return await contractProfile(symbol, query, trades, sourceSignal);
    const spans = await readContractSpans(client, symbol, query.from, query.to);
    const family = symbol.slice('KQ.m@'.length);
    const contracts = [...new Set(spans.map((s) => s.underlying))].filter(
      (s) => s.startsWith(family) && /^\d+$/.test(s.slice(family.length)),
    );
    if (!contracts.length)
      return empty('所选范围缺少主连历史合约映射，无法读取对应分笔。');
    if (contracts.length > 8)
      return empty('所选范围跨越过多合约，请缩小图表范围。');
    const result: VolumeProfileData = {
      segments: [],
      source: PROFILE_SOURCE,
      warnings: [],
    };
    const span = PROFILE_RANGES[query.range];
    for (const contract of contracts) {
      const covered: number[] = [];
      for (let start = query.from; start < query.to; start += span)
        if (
          spans.some(
            (s) =>
              s.underlying === contract &&
              s.from <= start &&
              s.to >= Math.min(start + span, query.to),
          )
        )
          covered.push(start);
      if (!covered.length) continue;
      const scoped = {
        ...query,
        from: covered[0],
        to: Math.min(covered.at(-1)! + span, query.to),
      };
      const data = await contractProfile(
        contract,
        scoped,
        trades,
        sourceSignal,
      );
      result.segments.push(
        ...data.segments.filter((segment) => covered.includes(segment.start)),
      );
      result.warnings.push(...data.warnings);
    }
    result.segments.sort((a, b) => a.start - b.start);
    result.warnings = [
      ...new Set([
        ...result.warnings,
        '主连仅显示历史映射完整且未跨换月的区间。',
      ]),
    ];
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) return empty('分笔读取超时，请缩小图表范围后重试。');
    if (error instanceof TradeDataError) return empty(error.message);
    if (
      error instanceof ClickHouseError &&
      [60, 497, 158, 159, 164].includes(error.code)
    )
      return empty(
        '通达信分笔表不可读或查询超限，请检查存储权限或缩小图表范围。',
      );
    throw error;
  }
}
