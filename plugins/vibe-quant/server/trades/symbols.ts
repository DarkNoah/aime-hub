import { TradeDataError } from './types.js';

export interface TradeInstrument {
  symbol: string;
  code: string;
  market: number;
  future: boolean;
  nightMinutes: number;
}
const markets: Record<string, number> = {
  CFFEX: 47,
  SHFE: 30,
  INE: 30,
  DCE: 29,
  CZCE: 28,
  GFEX: 66,
};
// Same product/night routing as stock-rl's futures-continuous.ts. Unknown
// products fail closed rather than placing their night prints on the wrong day.
const products: Record<string, string> = {
  CFFEX: 'IF IH IC IM TS TF T TL',
  SHFE: 'AD AG AL AO AU BR BU CU FU HC NI OP PB RB RU SN SP SS WR ZN',
  INE: 'BC EC LU NR SC',
  DCE: 'A B BB BZ C CS EB EG FB I J JD JM L L-F LG LH M P PG PP PP-F RR V V-F Y',
  CZCE: 'AP CF CJ CY FG MA OI PF PK PL PR PX RM RS SA SF SH SM SR TA UR JR PM RI WH ZC',
  GFEX: 'LC PD PS PT SI',
};
const noNight = new Set(
  'WR EC BB FB JD LG LH AP CJ PK RS SF SM UR JR PM RI WH'.split(' '),
);

export function tradeInstrument(symbol: string): TradeInstrument {
  const stock = /^(SSE|SZSE|BSE)\.(\d{6})$/.exec(symbol);
  if (stock) {
    if (
      (stock[1] === 'SSE' && stock[2].startsWith('000')) ||
      (stock[1] === 'SZSE' && stock[2].startsWith('399'))
    )
      throw new TradeDataError(
        '指数本身没有成交分笔，请选择实际股票、ETF 或期货合约。',
      );
    const exchange = { SSE: ['sh', 1], SZSE: ['sz', 0], BSE: ['bj', 2] }[
      stock[1]
    ]!;
    return {
      symbol,
      code: `${exchange[0]}${stock[2]}`,
      market: Number(exchange[1]),
      future: false,
      nightMinutes: 0,
    };
  }
  const match =
    /^(CFFEX|SHFE|INE|DCE|CZCE|GFEX)\.([A-Za-z]+(?:-[A-Za-z]+)?)(\d{3,4})$/.exec(
      symbol,
    );
  if (match && /^(0[1-9]|1[0-2])$/.test(match[3].slice(-2))) {
    const [, exchange, rawProduct, expiry] = match;
    const product = rawProduct.toUpperCase();
    if (products[exchange].split(' ').includes(product))
      return {
        symbol,
        code: product + expiry,
        market: markets[exchange],
        future: true,
        nightMinutes:
          exchange === 'CFFEX' || exchange === 'GFEX' || noNight.has(product)
            ? 0
            : ['AG', 'AU', 'SC'].includes(product)
              ? 330
              : ['AD', 'AL', 'AO', 'CU', 'NI', 'PB', 'SN', 'ZN', 'BC'].includes(
                    product,
                  )
                ? 240
                : 120,
      };
  }
  throw new TradeDataError(
    '通达信分笔暂不支持该标的；主连需具备历史实际合约映射，期权暂不接入。',
  );
}
