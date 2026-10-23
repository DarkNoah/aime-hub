import type { ProfileTrade } from '../../volume-profile.js';

/** Provider prints, not cumulative TqSdk quotes or exchange execution IDs. */
export interface TradePrint extends ProfileTrade {
  time: number;
  precision: 'second' | 'minute';
  direction: number;
  openInterestChange: number | null;
  nature: number | null;
  natureName: string;
}
export interface TradeDay {
  symbol: string;
  date: string;
  source: 'tdx-exhq-history' | 'tdx-security-history';
  sourceSymbol: string;
  market: number;
  fetchedAt: number;
  isFinal: boolean;
  trades: TradePrint[];
}
export class TradeDataError extends Error {}

export const DAY = 86400;
export const dateAt = (time: number) =>
  new Date((time + 8 * 3600) * 1000).toISOString().slice(0, 10);
export const midnight = (date: string) =>
  Date.parse(`${date}T00:00:00+08:00`) / 1000;

/** Stop waiting immediately without cancelling another reader's shared request. */
export function withSignal<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void task.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    task
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
