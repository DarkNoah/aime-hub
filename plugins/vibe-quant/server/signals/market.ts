import type { z } from 'zod';
import type { MarketStore } from '../clickhouse.js';
import { marketBarsQuery, readMarketBars } from '../market-bars.js';
import { StrategyError } from '../strategies/schema.js';
import type { MonitorStore } from './store.js';

/** Read the source engine, including historical contracts outside the watchlist. */
export async function readMonitorMarketBars(
  monitors: MonitorStore,
  market: MarketStore,
  owner: string,
  id: string,
  symbol: string,
  query: z.infer<typeof marketBarsQuery>,
) {
  let monitor = await monitors.get(id, owner);
  // Signal notifications and bookmarked chart URLs retain the original run ID.
  if (monitor.deleted && monitor.attachment_id) {
    const active = (await monitors.list(owner, monitor.strategy_id)).find(
      (row) => row.attachment_id === monitor.attachment_id,
    );
    if (active) monitor = active;
  }
  if (
    monitor.deleted ||
    (symbol !== monitor.config.symbol &&
      !(await monitors.history.hasSymbol(monitor.id, symbol)))
  )
    throw new StrategyError('MONITOR_NOT_FOUND', 404);
  return readMarketBars(market, monitor.engine, symbol, query);
}
