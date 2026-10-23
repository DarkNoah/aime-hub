import { StockSDK } from 'stock-sdk';
import { TradeDataError, withSignal } from './types.js';

/** The same stock-sdk trading calendar used by stock-rl. No weekday guesses. */
export class TradeCalendar {
  readonly dates: readonly string[];
  constructor(dates: readonly string[]) {
    if (
      dates.length < 2 ||
      dates.some(
        (date, i) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
          (i > 0 && date <= dates[i - 1]),
      )
    )
      throw new TradeDataError('通达信分笔交易日历格式异常。');
    this.dates = [...dates];
  }
  resolve(date: string) {
    if (date < this.dates[0] || date >= this.dates[this.dates.length - 1])
      throw new TradeDataError(
        `交易日历未覆盖 ${date}，无法确认分笔所属日期。`,
      );
    let low = 0,
      high = this.dates.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.dates[middle] < date) low = middle + 1;
      else high = middle;
    }
    const trading = this.dates[low] === date;
    return {
      trading,
      previous: this.dates[low - 1],
      next: this.dates[low + Number(trading)],
    };
  }
}

export function createTradeCalendarLoader() {
  const sdk = new StockSDK({
    timeout: 5000,
    retry: { maxRetries: 1, baseDelay: 500, maxDelay: 1000 },
  });
  let value: TradeCalendar | undefined,
    loadedAt = 0;
  let pending: Promise<TradeCalendar> | undefined;
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (value && Date.now() - loadedAt < 12 * 3600_000) return value;
    if (!pending) {
      sdk.clearCaches();
      pending = sdk.reference
        .tradingCalendar()
        .then((dates) => {
          value = new TradeCalendar(dates);
          loadedAt = Date.now();
          return value;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    return withSignal(pending, signal);
  };
}
