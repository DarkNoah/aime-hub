import { createHash } from 'node:crypto';
import type { PluginContext } from '@app/plugin-sdk/server';
import type { SyncStatus } from '../shared.js';
import type { CatalogRow, StateStore } from './state-store.js';

/** The released PostgreSQL migrations remain intact; old tables are kept as a backup. */
export async function migrateState(context: PluginContext, state: StateStore) {
  const [tables] = await context.database.query(`
    SELECT to_regclass('plugin_vibe_quant_instruments') IS NOT NULL AS catalog,
      to_regclass('plugin_vibe_quant_watchlist') IS NOT NULL AS watches,
      to_regclass('plugin_vibe_quant_status') IS NOT NULL AS status`);
  const catalog: CatalogRow[] = tables.catalog
    ? await context.database.query(
        'SELECT engine, symbol, metadata FROM plugin_vibe_quant_instruments ORDER BY engine, symbol',
      )
    : [];
  const watches: {
    userId: string;
    symbol: string;
    enabled: boolean;
    createdAt: number;
  }[] = tables.watches
    ? await context.database.query(
        `SELECT user_id AS "userId", symbol, enabled,
          extract(epoch FROM created_at)::double precision AS "createdAt"
         FROM plugin_vibe_quant_watchlist ORDER BY user_id, symbol`,
      )
    : [];
  const [status]: { payload: SyncStatus }[] = tables.status
    ? await context.database.query(
        'SELECT payload FROM plugin_vibe_quant_status WHERE id = 1',
      )
    : [];
  if (!catalog.length && !watches.length && !status) return;
  // Content addressing works even when independent deployments have the same
  // PostgreSQL host/database names. No connection secrets enter ClickHouse.
  const id = createHash('sha256')
    .update(JSON.stringify({ catalog, watches, status }))
    .digest('hex');
  await state.importLegacy(id, catalog, watches, status?.payload);
}
