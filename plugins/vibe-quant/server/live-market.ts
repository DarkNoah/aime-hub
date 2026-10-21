import type { Bar, Engine, OrderBook, Quote } from '../shared.js';

type LiveSymbol = {
  quote?: Quote;
  orderBook?: OrderBook;
  bars: Map<number, Map<number, Bar>>;
};

/** Per-collector overlay. History remains in ClickHouse; this cache is disposable. */
export class LiveMarket {
  private readonly engines = new Map<Engine, Map<string, LiveSymbol>>();

  private symbol(engine: Engine, symbol: string) {
    let symbols = this.engines.get(engine);
    if (!symbols) this.engines.set(engine, (symbols = new Map()));
    let value = symbols.get(symbol);
    if (!value) symbols.set(symbol, (value = { bars: new Map() }));
    return value;
  }

  update(engine: Engine, quotes: Quote[], bars: Bar[], books: OrderBook[]) {
    for (const quote of quotes) {
      const value = this.symbol(engine, quote.symbol);
      if (!value.quote || quote.time >= value.quote.time) value.quote = quote;
    }
    for (const book of books) {
      const value = this.symbol(engine, book.symbol);
      if (!value.orderBook || book.receivedAt >= value.orderBook.receivedAt)
        value.orderBook = book;
    }
    const changed = new Set<Map<number, Bar>>();
    for (const bar of bars) {
      const value = this.symbol(engine, bar.symbol);
      let series = value.bars.get(bar.duration);
      if (!series) value.bars.set(bar.duration, (series = new Map()));
      series.set(bar.time, bar);
      changed.add(series);
    }
    for (const series of changed) {
      // Bound memory during backfill and long-running sessions.
      const expired = [...series.keys()].sort((a, b) => b - a).slice(1000);
      for (const time of expired) series.delete(time);
    }
  }

  retainSymbols(engine: Engine, symbols: string[]) {
    const retained = new Set(symbols);
    const values = this.engines.get(engine);
    if (values)
      for (const symbol of values.keys())
        if (!retained.has(symbol)) values.delete(symbol);
  }

  quotes(engine: Engine, symbols: string[], saved: Quote[]) {
    const merged = new Map(saved.map((row) => [row.symbol, row]));
    for (const symbol of symbols) {
      const live = this.engines.get(engine)?.get(symbol)?.quote;
      const previous = merged.get(symbol);
      if (live && (!previous || live.time >= previous.time))
        merged.set(symbol, live);
    }
    return [...merged.values()];
  }

  orderBooks(engine: Engine, symbols: string[], saved: OrderBook[]) {
    const merged = new Map(saved.map((row) => [row.symbol, row]));
    for (const symbol of symbols) {
      const live = this.engines.get(engine)?.get(symbol)?.orderBook;
      const previous = merged.get(symbol);
      if (live && (!previous || live.receivedAt >= previous.receivedAt))
        merged.set(symbol, live);
    }
    return [...merged.values()];
  }

  bars(
    engine: Engine,
    symbol: string,
    duration: number,
    before: number,
    saved: Bar[],
    limit = 1000,
    after?: number,
  ) {
    const merged = new Map(saved.map((row) => [row.time, row]));
    const live = this.engines.get(engine)?.get(symbol)?.bars.get(duration);
    if (live)
      for (const row of live.values())
        if (row.time < before && (after === undefined || row.time > after))
          merged.set(row.time, row);
    const bars = [...merged.values()].sort((a, b) => a.time - b.time);
    return after === undefined ? bars.slice(-limit) : bars.slice(0, limit);
  }
}
