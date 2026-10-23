import {
  TdxClient,
  TdxExHqClient,
  type ExTradeTick,
  type TradeItem,
} from 'node-tdx-market';
import type { QuantConfig } from '../config.js';
import { TradeCalendar, createTradeCalendarLoader } from './calendar.js';
import { tradeInstrument, type TradeInstrument } from './symbols.js';
import {
  DAY,
  TradeDataError,
  dateAt,
  midnight,
  withSignal,
  type TradeDay,
  type TradePrint,
} from './types.js';

export const MAX_DAY_TRADES = 250_000;

/** Consume actual returned page lengths (vendors can cap the requested count).
 * Live pages overlap so new prints shifting offsets cannot be counted twice.
 * Repeated executions inside a page are retained; only ordered page overlap is trimmed.
 */
export async function collectTradePages<T>(
  fetchPage: (offset: number, count: number) => Promise<T[]>,
  signal: AbortSignal,
  live = false,
): Promise<T[]> {
  let offset = 0;
  let previous: string[] = [];
  const result: T[] = [];
  for (let requests = 0; requests < 1000; requests++) {
    signal.throwIfAborted();
    const page = await fetchPage(offset, 1800);
    signal.throwIfAborted();
    if (!page.length) {
      if (live && previous.length)
        throw new TradeDataError('分笔分页窗口发生变化，请稍后重试。');
      return result;
    }
    const keys = page.map((row) => JSON.stringify(row));
    if (
      previous.length === keys.length &&
      previous.every((key, i) => key === keys[i])
    )
      throw new TradeDataError('通达信重复返回同一分笔页，未保存不完整数据。');
    let overlap = 0;
    if (live && previous.length) {
      for (
        let length = Math.min(previous.length, keys.length);
        length > 0;
        length--
      )
        if (keys.slice(-length).every((key, i) => key === previous[i])) {
          overlap = length;
          break;
        }
      if (!overlap)
        throw new TradeDataError('实时分笔分页衔接无法确认，请稍后重试。');
      if (overlap === page.length) return result;
      if (new Set(keys.slice(-overlap)).size < 2)
        throw new TradeDataError('实时分笔分页重叠不明确，请稍后重试。');
    }
    result.push(...page.slice(0, page.length - overlap));
    if (result.length > MAX_DAY_TRADES)
      throw new TradeDataError('单日分笔超过计算上限，未保存部分数据。');
    previous = keys;
    offset +=
      page.length - (live ? Math.min(64, Math.floor(page.length / 2)) : 0);
  }
  throw new TradeDataError('分笔分页超过上限，请稍后重试。');
}

export function futureTradeTime(
  date: string,
  row: Pick<ExTradeTick, 'hour' | 'minute' | 'second'>,
  instrument: TradeInstrument,
  calendar: TradeCalendar,
) {
  if (
    ![row.hour, row.minute, row.second].every(Number.isInteger) ||
    row.hour < 0 ||
    row.hour > 47 ||
    row.minute < 0 ||
    row.minute > 59 ||
    row.second < 0 ||
    row.second > 59
  )
    throw new TradeDataError('通达信期货分笔时间无效。');
  const minute = (row.hour % 24) * 60 + row.minute;
  let base = midnight(date);
  if (instrument.nightMinutes && (minute >= 1260 || minute <= 180)) {
    const previous = calendar.resolve(date).previous;
    if (!previous)
      throw new TradeDataError('缺少上一交易日，无法定位夜盘分笔。');
    base = midnight(previous) + (minute <= 180 ? DAY : 0);
  }
  return base + minute * 60 + row.second;
}

export function normalizeTrades(
  rows: ExTradeTick[] | TradeItem[],
  date: string,
  instrument: TradeInstrument,
  calendar: TradeCalendar,
): TradePrint[] {
  return rows.flatMap((raw): TradePrint[] => {
    if (raw.volume === 0) return [];
    const row = raw;
    const security = raw as TradeItem,
      future = raw as ExTradeTick;
    const time = instrument.future
      ? futureTradeTime(date, future, instrument, calendar)
      : /^([01]\d|2[0-3]):[0-5]\d$/.test(security.time)
        ? Date.parse(`${date}T${security.time}:00+08:00`) / 1000
        : NaN;
    // stock-rl's transaction price scale differs from its quote scale (notably ETFs/BSE).
    const divisor =
      !instrument.future && /^(?:4|8|92)/.test(instrument.code.slice(2))
        ? 100
        : 1000;
    const price = row.price / divisor;
    if (
      ![time, price, row.volume].every((n) => Number.isFinite(n) && n > 0) ||
      !Number.isSafeInteger(row.direction)
    )
      throw new TradeDataError(
        '通达信分笔含无效时间、价格或成交量，未保存部分数据。',
      );
    const side = instrument.future
      ? row.direction === 1
        ? 'buy'
        : row.direction === -1
          ? 'sell'
          : 'unknown'
      : row.direction === 0
        ? 'buy'
        : row.direction === 1
          ? 'sell'
          : 'unknown';
    return [
      {
        time,
        price,
        size: row.volume,
        side,
        direction: row.direction,
        precision: instrument.future ? 'second' : 'minute',
        openInterestChange: instrument.future ? future.zengCang : null,
        nature: instrument.future ? future.nature : null,
        natureName: instrument.future ? future.natureName : '',
      },
    ];
  });
}

export class TdxTradeProvider {
  constructor(
    private readonly config: QuantConfig,
    private readonly calendar = createTradeCalendarLoader(),
  ) {}

  async readDay(
    symbol: string,
    date: string,
    signal: AbortSignal,
  ): Promise<TradeDay> {
    const instrument = tradeInstrument(symbol);
    const calendar = await this.calendar(signal);
    const resolution = calendar.resolve(date);
    const start = midnight(date),
      end = start + DAY;
    const dates = new Set<string>();
    if (resolution.trading) dates.add(date);
    if (instrument.nightMinutes) {
      const nightStart = futureTradeTime(
        resolution.next,
        { hour: 21, minute: 0, second: 0 },
        instrument,
        calendar,
      );
      if (nightStart < end && nightStart + instrument.nightMinutes * 60 > start)
        dates.add(resolution.next);
    }
    const fetchedAt = Date.now() / 1000;
    const today = dateAt(fetchedAt);
    const todayResolution = calendar.resolve(today);
    const afterNightOpen = fetchedAt - midnight(today) >= 21 * 3600;
    const activeTradingDate =
      instrument.nightMinutes && (afterNightOpen || !todayResolution.trading)
        ? todayResolution.next
        : today;
    const output: TradeDay = {
      symbol,
      date,
      source: instrument.future ? 'tdx-exhq-history' : 'tdx-security-history',
      sourceSymbol: instrument.code,
      market: instrument.market,
      fetchedAt,
      isFinal: date < today && [...dates].every((day) => day < today),
      trades: [],
    };
    if (!dates.size) return output;
    const extended = instrument.future
      ? new TdxExHqClient({
          host: this.config.tdxTradeFutureHost,
          autoReconnect: false,
          connectTimeout: 4000,
          requestTimeout: 8000,
        })
      : undefined;
    const securities = !extended
      ? new TdxClient({
          host: this.config.tdxTradeStockHost,
          autoReconnect: false,
          connectTimeout: 4000,
          requestTimeout: 8000,
        })
      : undefined;
    const client = (extended ?? securities)!;
    client.on('error', () => {});
    const destroy = () => client.destroy();
    signal.addEventListener('abort', destroy, { once: true });
    try {
      signal.throwIfAborted();
      await withSignal(client.connect(), signal);
      for (const day of dates) {
        // After 21:00 the live ExHq window belongs to the NEXT trading day.
        // Today's day session must then use getHistoryTrade, not that night window.
        const live = day >= activeTradingDate;
        const numericDate = Number(day.replaceAll('-', ''));
        const rows = await collectTradePages<ExTradeTick | TradeItem>(
          async (offset, count) => {
            signal.throwIfAborted();
            if (!extended && offset > 65535)
              throw new TradeDataError('证券分笔超出接口分页范围。');
            return extended
              ? await withSignal(
                  live
                    ? extended.getTrade(
                        instrument.market,
                        instrument.code,
                        offset,
                        count,
                      )
                    : extended.getHistoryTrade(
                        instrument.market,
                        instrument.code,
                        numericDate,
                        offset,
                        count,
                      ),
                  signal,
                )
              : (
                  await withSignal(
                    live
                      ? securities!.getTrade(instrument.code, offset, count)
                      : securities!.getHistoryTrade(
                          instrument.code,
                          numericDate,
                          offset,
                          count,
                        ),
                    signal,
                  )
                ).items;
          },
          signal,
          live,
        );
        if (!rows.length)
          throw new TradeDataError(
            `${day} ${instrument.code} 无分笔返回，可能超出数据源保留范围。`,
          );
        output.trades.push(
          ...normalizeTrades(
            rows as ExTradeTick[] | TradeItem[],
            day,
            instrument,
            calendar,
          ).filter(
            (row) =>
              row.time >= start && row.time < end && row.time <= fetchedAt,
          ),
        );
      }
      output.trades.sort((a, b) => a.time - b.time);
      return output;
    } finally {
      signal.removeEventListener('abort', destroy);
      destroy();
    }
  }
}
