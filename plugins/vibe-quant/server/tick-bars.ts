import { MONTH_DURATION, type Bar, type Engine } from '../shared.js';
import { ClickHouseClient, ClickHouseError } from './clickhouse-client.js';
import { nextPeriodStart } from './bar-periods.js';
import { readContractSpans } from './contract-spans.js';

interface TickBar {
  time: number;
  volume: number;
  amount: number | null;
  /** Empty unless a complete interval contains trades with valid prices. */
  ohlc: (number | null)[];
}

interface TimedTickBar extends TickBar {
  firstTime: number;
  lastTime: number;
}

/** Rebuild prices and fill missing turnover only after matching source volume. */
export function mergeTickBars(bars: Bar[], ticks: TickBar[]): Bar[] {
  const byTime = new Map(ticks.map((row) => [row.time, row]));
  return bars.map((bar) => {
    const row = byTime.get(bar.time);
    if (
      !row ||
      !Number.isFinite(row.volume) ||
      row.volume < 0 ||
      !Number.isFinite(bar.volume) ||
      Math.abs(row.volume - bar.volume) > 0.000001
    )
      return bar;
    const [open, high, low, close] = row.ohlc;
    const pricesValid =
      row.volume > 0 &&
      row.ohlc.length === 4 &&
      row.ohlc.every(
        (value) => value != null && Number.isFinite(value) && value > 0,
      ) &&
      low! <= Math.min(open!, close!) &&
      high! >= Math.max(open!, close!) &&
      low! <= high!;
    const amountValid =
      bar.amount == null &&
      row.amount != null &&
      Number.isFinite(row.amount) &&
      row.amount >= 0;
    if (!pricesValid && !amountValid) return bar;
    return {
      ...bar,
      ...(pricesValid
        ? { open: open!, high: high!, low: low!, close: close! }
        : {}),
      ...(amountValid ? { amount: row.amount } : {}),
    };
  });
}

/** Recompute from FINAL ticks: later backfills/corrections repair the result without
 * persisting a derived value that could become stale. No raw ticks leave ClickHouse.
 */
export async function rebuildTickBars(
  client: ClickHouseClient,
  engine: Engine,
  symbol: string,
  duration: number,
  bars: Bar[],
): Promise<Bar[]> {
  // Weighted indices have no single underlying contract.
  if (
    engine !== 'tqsdk' ||
    (symbol.startsWith('KQ.') && !symbol.startsWith('KQ.m@')) ||
    !bars.length
  )
    return bars;
  try {
    const ticks = symbol.startsWith('KQ.m@')
      ? await readContinuousTicks(client, symbol, duration, bars)
      : await readTickBars(client, symbol, duration, bars);
    return mergeTickBars(bars, ticks);
  } catch (error) {
    // Legacy/read-only installations may not have readable source tables. A
    // bounded query that cannot finish must not turn a partial sum into data.
    if (
      error instanceof ClickHouseError &&
      // readonly=1 also rejects the per-query SETTINGS used by the bounded
      // reconstruction query (164). Stored/overlaid bars remain readable.
      [60, 497, 158, 159, 164].includes(error.code)
    )
      return bars;
    throw error;
  }
}

async function readContinuousTicks(
  client: ClickHouseClient,
  symbol: string,
  duration: number,
  bars: Bar[],
): Promise<TickBar[]> {
  const family = symbol.slice('KQ.m@'.length);
  const from = bars[0].time;
  const to =
    duration === MONTH_DURATION
      ? nextPeriodStart(bars.at(-1)!.time, duration)
      : bars.at(-1)!.time + duration;
  let spans = await readContractSpans(client, symbol, from, to);
  const contracts = [...new Set(spans.map((span) => span.underlying))].filter(
    (contract) =>
      contract.startsWith(family) &&
      /^\d+$/.test(contract.slice(family.length)),
  );
  const candidates: { symbol: string; ticks: TimedTickBar[] }[] = [];
  for (const contract of contracts) {
    candidates.push({
      symbol: contract,
      ticks: await readTickBars(client, contract, duration, bars),
    });
  }
  // Trading-day bars can start on a previous evening, weekend or calendar month.
  // Expand by the actual Tick timestamps, without guessing a night-session date.
  if (duration >= 86400) {
    let first = from;
    for (const { ticks } of candidates)
      for (const tick of ticks) first = Math.min(first, tick.firstTime);
    if (first < from)
      spans = await readContractSpans(client, symbol, first, to);
  }
  return candidates.flatMap(({ symbol: contract, ticks }) =>
    ticks.filter((tick) => {
      const first = duration >= 86400 ? tick.firstTime : tick.time;
      const last =
        duration >= 86400
          ? tick.lastTime
          : nextPeriodStart(tick.time, duration);
      // Only one observed contract run may cover the whole interval. In
      // particular, a month containing a roll cannot borrow either leg alone.
      return spans.some(
        (span) =>
          span.underlying === contract && span.from <= first && span.to >= last,
      );
    }),
  );
}

async function readTickBars(
  client: ClickHouseClient,
  symbol: string,
  duration: number,
  bars: Bar[],
): Promise<TimedTickBar[]> {
  const daily = duration >= 86400;
  const from = bars[0].time;
  const to =
    duration === MONTH_DURATION
      ? nextPeriodStart(bars.at(-1)!.time, duration)
      : bars.at(-1)!.time + duration;
  const date = (time: number) =>
    new Date((time + 28800) * 1000).toISOString().slice(0, 10);
  const ns = (time: number) => String(BigInt(time) * 1_000_000_000n);
  const columns = 'timeNs, tickId, tradingDay, volume, amount, last';
  const scoped = `FROM ${client.table('ticks')} FINAL WHERE engine = {engine:String} AND symbol = {symbol:String}`;
  const identities = `FROM ${client.table('ticks')} WHERE engine = {engine:String} AND symbol = {symbol:String}`;
  // Daily bars are labelled by trading day, so Friday night belongs to Monday.
  const key = daily ? 'tradingDay' : 'timeNs';
  const lower = daily ? '{fromDay:Date}' : '{fromNs:UInt64}';
  const upper = daily ? '{toDay:Date}' : '{toNs:UInt64}';
  // Locate immutable keys in storage order without FINAL's full-history merge;
  // read the selected records WITH FINAL below so corrected values still win.
  const neighbor = (predicate: string, descending: boolean) => {
    const order = descending ? 'DESC' : 'ASC';
    return `SELECT ${columns} ${scoped} AND (tradingDay, timeNs, tickId) IN (
      SELECT tradingDay, timeNs, tickId ${identities} AND ${predicate}
      ORDER BY tradingDay ${order}, timeNs ${order}, tickId ${order} LIMIT 1)`;
  };
  const periodDate =
    duration === MONTH_DURATION ? 'toStartOfMonth(tradingDay)' : 'tradingDay';
  const periodTime = daily
    ? `toUInt64(toUnixTimestamp(toDateTime(${periodDate}, 'Asia/Shanghai')))`
    : 'intDiv(timeNs, toUInt64({duration:UInt32}) * 1000000000) * {duration:UInt32}';
  const periodEnd =
    duration === MONTH_DURATION
      ? 'addMonths(periodDate, 1)'
      : 'addDays(periodDate, 1)';
  const startCovered = daily
    ? '(previous.3 < periodDate AND rn > 1) OR (rn = 1 AND volume = 0 AND tradingDay = periodDate)'
    : '(previous.1 < periodTime * 1000000000 AND rn > 1) OR (rn = 1 AND volume = 0)';
  const endCovered = daily
    ? `following.3 >= ${periodEnd}`
    : 'following.1 >= (periodTime + {duration:UInt32}) * 1000000000';
  return client.rows<TimedTickBar>(
    `WITH source AS (
        SELECT ${columns} ${scoped} AND ${key} >= ${lower} AND ${key} < ${upper}
        UNION ALL
        ${neighbor(`${key} < ${lower}`, true)}
        UNION ALL
        ${neighbor(`${key} >= ${upper}`, false)}
      ), ordered AS (
        SELECT *, row_number() OVER w AS rn,
          lagInFrame(tuple(timeNs, tickId, tradingDay, volume, amount)) OVER w AS previous,
          leadInFrame(tuple(timeNs, tickId, tradingDay, volume, amount)) OVER w AS following
        FROM source WINDOW w AS (ORDER BY timeNs, tickId ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
      ), steps AS (
        SELECT *, ${periodTime} AS periodTime, ${periodDate} AS periodDate,
          rn > 1 AND tradingDay = previous.3 AS sameDay,
          if(sameDay, volume - previous.4, volume) AS deltaVolume,
          if(sameDay, amount - previous.5, amount) AS deltaAmount,
          ifNull(isFinite(volume) AND volume >= 0
            AND ((rn > 1 AND tickId = previous.2 + 1 AND tradingDay >= previous.3
              AND (NOT sameDay OR (isFinite(previous.4) AND previous.4 >= 0)))
              OR (rn = 1 AND volume = 0))
            AND deltaVolume >= 0, false) AS volumeUsable,
          ifNull(volumeUsable AND isFinite(amount) AND amount >= 0
            AND (NOT sameDay OR (isFinite(previous.5) AND previous.5 >= 0))
            AND deltaAmount >= 0
            AND ((deltaVolume = 0 AND deltaAmount = 0) OR (deltaVolume > 0 AND deltaAmount > 0)), false) AS amountUsable,
          ifNull(deltaVolume > 0, false) AS traded,
          ifNull(isFinite(last) AND last > 0, false) AS validPrice,
          ifNull((${startCovered}), false) AS startCovered,
          following.1 > 0 AND following.2 = tickId + 1 AND (${endCovered}) AS endCovered
        FROM ordered
      )
      SELECT toFloat64(periodTime) AS time, sum(ifNull(deltaVolume, 0)) AS volume,
        min(timeNs) / 1000000000 AS firstTime, max(timeNs) / 1000000000 AS lastTime,
        countIf(NOT volumeUsable) = 0
          AND argMin(startCovered, tuple(timeNs, tickId))
          AND argMax(endCovered, tuple(timeNs, tickId)) AS complete,
        if(complete AND countIf(NOT amountUsable) = 0, sum(ifNull(deltaAmount, 0)), NULL) AS amount,
        if(complete AND countIf(traded) > 0 AND countIf(traded AND NOT validPrice) = 0,
          [argMinIf(last, tuple(timeNs, tickId), traded), maxIf(last, traded),
           minIf(last, traded), argMaxIf(last, tuple(timeNs, tickId), traded)], []) AS ohlc
      FROM steps WHERE ${key} >= ${lower} AND ${key} < ${upper}
      GROUP BY periodTime
      SETTINGS max_execution_time = 8, max_rows_to_read = 10000000, read_overflow_mode = 'throw'`,
    {
      engine: 'tqsdk',
      symbol,
      duration: String(duration),
      fromNs: ns(from),
      toNs: ns(to),
      fromDay: date(from),
      toDay: date(to),
    },
  );
}
