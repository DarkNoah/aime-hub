import type { QuantConfig } from '../config.js';
import { TdxTradeProvider } from './provider.js';
import { TradeStore } from './store.js';
import { TradeDataError, withSignal, type TradeDay } from './types.js';

export interface TradeReader {
  readDay(symbol: string, date: string, signal: AbortSignal): Promise<TradeDay>;
}

/** Shared across charts; only requested days are fetched, as in stock-rl.
 * A persisted current-day prefix never becomes a finalized day just by aging.
 */
export class TradeService implements TradeReader {
  private readonly lifetime = new AbortController();
  private readonly inflight = new Map<
    string,
    {
      controller: AbortController;
      task: Promise<TradeDay>;
      readers: number;
    }
  >();
  constructor(
    private readonly config: QuantConfig,
    readonly store = new TradeStore(config),
    private readonly provider: TradeReader = new TdxTradeProvider(config),
  ) {}

  initialize() {
    return this.store.initialize();
  }
  async stop() {
    this.lifetime.abort(new Error('分笔服务已停止'));
    await Promise.allSettled(
      [...this.inflight.values()].map((item) => item.task),
    );
  }
  async readDay(
    symbol: string,
    date: string,
    signal: AbortSignal,
  ): Promise<TradeDay> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    const saved = await withSignal(this.store.readDay(symbol, date), signal);
    if (
      saved &&
      (saved.isFinal ||
        this.config.clickhouseReadOnly ||
        Date.now() / 1000 - saved.fetchedAt < 15)
    )
      return saved;
    if (this.config.clickhouseReadOnly)
      throw new TradeDataError(
        `${date} 尚无已保存的通达信分笔；当前服务处于行情只读模式。`,
      );
    const key = `${symbol}:${date}`;
    let pending = this.inflight.get(key);
    if (pending?.controller.signal.aborted) {
      this.inflight.delete(key);
      pending = undefined;
    }
    if (!pending) {
      if (this.inflight.size >= 4)
        throw new TradeDataError('分笔采集繁忙，请稍后重试。');
      const controller = new AbortController();
      const sourceSignal = AbortSignal.any([
        controller.signal,
        this.lifetime.signal,
        AbortSignal.timeout(45_000),
      ]);
      const task = this.provider
        .readDay(symbol, date, sourceSignal)
        .then(async (day) => {
          sourceSignal.throwIfAborted();
          await this.store.saveDay(day);
          return day;
        })
        .finally(() => {
          if (this.inflight.get(key)?.task === task) this.inflight.delete(key);
        });
      pending = { controller, task, readers: 0 };
      this.inflight.set(key, pending);
    }
    pending.readers++;
    try {
      return await withSignal(pending.task, signal);
    } finally {
      if (--pending.readers === 0)
        pending.controller.abort(new Error('分笔请求已取消'));
    }
  }
}
