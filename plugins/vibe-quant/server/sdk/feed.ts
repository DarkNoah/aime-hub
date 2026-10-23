import { randomUUID } from 'node:crypto';
import type { Bar, Quote } from '../../shared.js';

export interface MarketBatch {
  quotes: Quote[];
  bars: Bar[];
}
export interface FeedBatch extends MarketBatch {
  cursor: string;
  receivedAt: number;
}

/** Bounded process feed. A lost cursor is an explicit gap, never silently reset. */
export class StrategyFeed {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private rows = 0;
  private batches: { sequence: number; rows: number; value: FeedBatch }[] = [];
  constructor(private readonly maxRows = 50_000) {}

  get cursor() {
    return `${this.epoch}:${this.sequence}`;
  }

  publish(batch: MarketBatch) {
    const rows = batch.quotes.length + batch.bars.length;
    if (!rows) return;
    this.sequence++;
    const value = {
      quotes: batch.quotes,
      bars: batch.bars,
      cursor: this.cursor,
      receivedAt: Date.now() / 1000,
    };
    this.batches.push({ sequence: this.sequence, rows, value });
    this.rows += rows;
    while (this.batches.length && this.rows > this.maxRows)
      this.rows -= this.batches.shift()!.rows;
  }

  read(cursor: string, symbols: Set<string>) {
    const [epoch, value, extra] = cursor.split(':');
    const sequence = Number(value);
    if (
      epoch !== this.epoch ||
      extra !== undefined ||
      !/^\d+$/.test(value ?? '') ||
      !Number.isSafeInteger(sequence) ||
      sequence > this.sequence ||
      sequence < (this.batches[0]?.sequence ?? this.sequence + 1) - 1
    )
      return null;
    const selected = this.batches
      .filter((batch) => batch.sequence > sequence)
      .slice(0, 100);
    // A main-contract quote grants access only to its observed actual contracts.
    for (const { value: batch } of selected)
      for (const quote of batch.quotes)
        if (
          symbols.has(quote.symbol) &&
          quote.symbol.startsWith('KQ.m@') &&
          quote.underlying
        )
          symbols.add(quote.underlying);
    const batches = selected.map(({ value: batch }) => ({
      cursor: batch.cursor,
      receivedAt: batch.receivedAt,
      quotes: batch.quotes.filter((row) => symbols.has(row.symbol)),
      bars: batch.bars.filter((row) => symbols.has(row.symbol)),
    }));
    return { cursor: selected.at(-1)?.value.cursor ?? cursor, batches };
  }
}
