import { z } from 'zod';
import type { ClickHouseClient } from './clickhouse-client.js';
import type { Engine, Instrument } from '../shared.js';

export const symbolSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.@-]+$/);

export function searchTerms(value: string) {
  const term = value
    .trim()
    .slice(0, 80)
    .replace(/[%_\\]/g, '\\$&');
  const continuous = /主连|主力连续/i.test(term);
  return {
    term: term
      .replace(/主力连续|主连/g, '')
      .replace(/xxx$|\*$/i, '')
      .trim(),
    continuous,
  };
}
export function supports(engine: Engine, instrument: Instrument) {
  return (
    !instrument.historyOnly &&
    !instrument.expired &&
    (engine === 'tqsdk' || instrument.kind === 'stock')
  );
}

/** Bars imported before a catalog was saved carry just the qualified symbol. */
export function historicalInstrument(
  symbol: string,
  known?: Instrument,
): Instrument {
  if (known) return { ...known, localHistory: true, historyOnly: true };
  const [exchange, code = ''] = symbol.replace(/^KQ\.[im]@/, '').split('.');
  const isEquityExchange = ['SSE', 'SZSE', 'BSE'].includes(exchange);
  const option =
    /^[A-Za-z]+\d{3,4}-?[CP]-?\d/i.test(code) ||
    (isEquityExchange && /^\d{8}$/.test(code));
  return {
    symbol,
    name: symbol,
    exchange,
    product: code.match(/^[A-Za-z]+/)?.[0] ?? '',
    kind: symbol.startsWith('KQ.')
      ? 'continuous'
      : option
        ? 'option'
        : isEquityExchange
          ? 'stock'
          : 'future',
    priceTick: 0.01,
    underlying: '',
    expired: false,
    localHistory: true,
    historyOnly: true,
  };
}

export async function symbolsWithBars(
  client: ClickHouseClient,
  engine: Engine,
  symbols: string[],
): Promise<Set<string>> {
  if (!symbols.length) return new Set();
  const rows = await client.rows<{ symbol: string }>(
    `SELECT DISTINCT symbol FROM ${client.table('bars')}
     WHERE engine = {engine:String}
       AND symbol IN (SELECT arrayJoin(JSONExtract({symbols:String}, 'Array(String)')))
     SETTINGS optimize_distinct_in_order = 1`,
    { engine, symbols: JSON.stringify(symbols) },
  );
  return new Set(rows.map((row) => row.symbol));
}
