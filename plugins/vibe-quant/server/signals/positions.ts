import type { ClickHouseClient } from '../clickhouse-client.js';
import type { MarketPosition } from '../../market-positions.js';
import type { OpenTrade, Trade } from '../../strategy-types.js';
import { StrategyError } from '../strategies/schema.js';

type PositionCursor = { time: number; monitor: string; id: string };

/** IDs must come from the authenticated user's visible, non-deleted monitors. */
export async function readMarketPositions(
  store: ClickHouseClient,
  monitors: string[],
  before?: string,
) {
  let cursor: PositionCursor | undefined;
  if (before !== undefined) {
    try {
      cursor = JSON.parse(Buffer.from(before, 'base64url').toString());
      if (
        !cursor ||
        !Number.isFinite(cursor.time) ||
        cursor.time < 0 ||
        typeof cursor.monitor !== 'string' ||
        typeof cursor.id !== 'string'
      )
        throw new Error();
    } catch {
      throw new StrategyError('INVALID_MONITOR_CONFIG');
    }
  }
  const empty = { open: [], history: [], progress: [], next: null };
  if (!monitors.length) return empty;
  const scope =
    "monitorId IN (SELECT arrayJoin(JSONExtract({monitors:String}, 'Array(String)')))";
  const params = { monitors: JSON.stringify(monitors) };
  const [summaries, closed] = await Promise.all([
    store.rows<{
      monitorId: string;
      opened: string;
      through: number;
      replaying: boolean;
    }>(
      `SELECT monitorId, JSONExtractRaw(payload,'open_trades') AS opened,
       JSONExtractFloat(payload,'through') AS through,
       JSONExtractBool(payload,'replaying') AS replaying
       FROM ${store.table('quant_signal_history')} FINAL
       WHERE ${scope} AND kind='summary' AND id='summary'`,
      params,
    ),
    store.rows<{
      monitorId: string;
      id: string;
      time: number;
      payload: string;
    }>(
      `SELECT monitorId,id,time,payload FROM ${store.table('quant_signal_history')} FINAL
       WHERE ${scope} AND kind='trade'
       ${cursor ? 'AND (time,monitorId,id)<({time:Float64},{monitor:String},{id:String})' : ''}
       ORDER BY time DESC,monitorId DESC,id DESC LIMIT 51`,
      {
        ...params,
        time: String(cursor?.time ?? 0),
        monitor: cursor?.monitor ?? '',
        id: cursor?.id ?? '',
      },
    ),
  ]);
  const open: MarketPosition<OpenTrade>[] = summaries.flatMap((row) =>
    (JSON.parse(row.opened || '[]') as OpenTrade[]).map((trade) => ({
      monitor_id: row.monitorId,
      trade: withoutRiskLevels(trade),
    })),
  );
  open.sort(
    (a, b) =>
      b.trade.entry_time - a.trade.entry_time ||
      b.monitor_id.localeCompare(a.monitor_id) ||
      b.trade.id.localeCompare(a.trade.id),
  );
  const page = closed.slice(0, 50);
  const last = page.at(-1);
  return {
    open,
    history: page.map((row) => ({
      monitor_id: row.monitorId,
      trade: withoutRiskLevels(JSON.parse(row.payload) as Trade),
    })),
    progress: summaries.map((row) => ({
      monitor_id: row.monitorId,
      through: row.through,
      replaying: !!row.replaying,
    })),
    next:
      closed.length > 50 && last
        ? Buffer.from(
            JSON.stringify({
              time: last.time,
              monitor: last.monitorId,
              id: last.id,
            }),
          ).toString('base64url')
        : null,
  };
}

function withoutRiskLevels<T extends OpenTrade | Trade>(trade: T): T {
  const copy = { ...trade };
  delete copy.risk_levels;
  return copy;
}
