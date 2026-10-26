import type {
  BacktestResult,
  OpenTrade,
  TradeRecord,
} from './strategy-types.js';

const entryKey = (
  symbol: string,
  side: string,
  signal: string | null,
  time: number,
  price: number,
) => JSON.stringify([symbol, side, signal, time, price]);

/** Reconstruct remaining entry lots from immutable results, including old runs.
 * Closed trades identify the exact entry lot, so targeted risk exits do not
 * accidentally consume a different entry with the same symbol.
 */
export function resultTradeRecords(result: BacktestResult): TradeRecord[] {
  const closed = result.trades ?? [];
  const closedQuantities = new Map<string, number>();
  for (const trade of closed) {
    const key = entryKey(
      trade.symbol,
      trade.side,
      trade.entry_signal_id,
      trade.entry_time,
      trade.entry_price,
    );
    closedQuantities.set(
      key,
      (closedQuantities.get(key) ?? 0) + trade.quantity,
    );
  }
  const open: OpenTrade[] = [];
  const pendingRisk = new Map<string, string>();
  for (const order of result.orders ?? []) {
    if (
      order.status !== 'filled' &&
      typeof order.risk_entry_signal_id === 'string' &&
      typeof order.symbol === 'string' &&
      typeof order.risk_level_id === 'string'
    )
      pendingRisk.set(
        JSON.stringify([order.symbol, order.risk_entry_signal_id]),
        order.risk_level_id,
      );
  }
  for (const [index, fill] of (result.fills ?? []).entries()) {
    if (
      fill.offset !== 'open' ||
      typeof fill.symbol !== 'string' ||
      typeof fill.quantity !== 'number' ||
      !Number.isFinite(fill.quantity) ||
      !fill.quantity ||
      typeof fill.time !== 'number' ||
      !Number.isFinite(fill.time) ||
      typeof fill.price !== 'number' ||
      !Number.isFinite(fill.price)
    )
      continue;
    const side = fill.quantity > 0 ? 'long' : 'short';
    const signal = typeof fill.signal_id === 'string' ? fill.signal_id : null;
    const key = entryKey(fill.symbol, side, signal, fill.time, fill.price);
    const quantity = Math.abs(fill.quantity);
    const consumed = Math.min(quantity, closedQuantities.get(key) ?? 0);
    closedQuantities.set(key, (closedQuantities.get(key) ?? 0) - consumed);
    const remaining = quantity - consumed;
    if (!remaining) continue;
    open.push({
      id: `open:${typeof fill.id === 'string' ? fill.id : index}`,
      status: 'open',
      symbol: fill.symbol,
      side,
      quantity: remaining,
      entry_time: fill.time,
      entry_price: fill.price,
      entry_signal_id: signal,
      risk_level_id:
        pendingRisk.get(JSON.stringify([fill.symbol, signal])) ?? null,
      exit_time: null,
      exit_price: null,
      exit_signal_id: null,
      gross_pnl: null,
      net_pnl: null,
      fees:
        typeof fill.fee === 'number' ? (fill.fee * remaining) / quantity : 0,
      observed_until: Math.max(
        fill.time,
        result.equity_curve?.at(-1)?.time ?? fill.time,
      ),
    });
  }
  return [...closed, ...open];
}
