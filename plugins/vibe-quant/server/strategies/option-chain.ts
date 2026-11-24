import type { Engine, Instrument } from '../../shared.js';
import type { MarketStore } from '../clickhouse.js';
import { historicalInstrument } from '../symbols.js';
import { indexOptionSeries } from '../../option-families.js';

export async function hasOptionProduct(
  store: Pick<MarketStore, 'rows' | 'table'>,
  engine: Engine,
  source: string,
) {
  if (indexOptionSeries(source)) return true;
  const main = source.startsWith('KQ.m@') ? source.slice(5) : '';
  const rows = await store.rows(
    `SELECT 1 FROM ${store.table('quant_instruments')} FINAL
     WHERE engine={engine:String} AND JSONExtractString(metadata,'kind')='option'
       AND (JSONExtractString(metadata,'underlying')={source:String} OR
         ({main:String} != '' AND replaceRegexpOne(JSONExtractString(metadata,'underlying'), '[0-9]+$', '')={main:String}))
     LIMIT 1`,
    { engine, source, main },
  );
  return rows.length > 0;
}

/** Include expired contracts. Only minute bars observed at the decision time
 * can make any of these candidates eligible in the SDK. */
export async function optionChain(
  store: MarketStore,
  engine: Engine,
  sources: string[],
  start: number,
  end: number,
): Promise<Instrument[]> {
  const months = new Map<string, string>();
  for (const source of sources) {
    const series = indexOptionSeries(source);
    if (series?.month)
      months.set(`CFFEX.${series.option}${series.month}-`, series.underlying);
  }
  const params = {
    engine,
    sources: JSON.stringify(sources),
    months: JSON.stringify([...months.keys()]),
    start: String(start),
    end: String(end),
  };
  const rows = await store.rows<{ metadata: string }>(
    `SELECT metadata FROM ${store.table('quant_instruments')} FINAL
     WHERE engine={engine:String} AND JSONExtractString(metadata,'kind')='option'
       AND (has(JSONExtract({sources:String},'Array(String)'), JSONExtractString(metadata,'underlying'))
         OR arrayExists(prefix -> startsWith(symbol,prefix), JSONExtract({months:String},'Array(String)')))`,
    params,
  );
  const instruments = new Map<string, Instrument>();
  for (const row of rows) {
    const item: Instrument = JSON.parse(row.metadata);
    instruments.set(item.symbol, item);
  }
  // Imported index option bars can predate the saved catalog.
  if (months.size) {
    const saved = await store.rows<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM ${store.table('bars')} WHERE engine={engine:String} AND duration=60
       AND time >= {start:UInt64} AND time < {end:UInt64}
       AND arrayExists(prefix -> startsWith(symbol,prefix), JSONExtract({months:String},'Array(String)'))`,
      params,
    );
    for (const { symbol } of saved) {
      if (!instruments.has(symbol)) {
        const prefix = symbol.slice(0, symbol.indexOf('-') + 1);
        instruments.set(symbol, {
          ...historicalInstrument(symbol),
          underlying: months.get(prefix)!,
          priceTick: 0.2,
        });
      }
    }
  }
  return [...instruments.values()];
}
