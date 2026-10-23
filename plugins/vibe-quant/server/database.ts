import type { MigrationInterface, QueryRunner } from 'typeorm';
import type { PluginDatabase } from '@app/plugin-sdk/server';
import { StrategyManagement1792600000000 } from './strategies/migration.js';

class CreateVibeQuant1792100000000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE plugin_vibe_quant_instruments (
      engine text NOT NULL, symbol text NOT NULL, metadata jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (engine, symbol)
    )`);
    await runner.query(`CREATE TABLE plugin_vibe_quant_watchlist (
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol text NOT NULL, enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, symbol)
    )`);
    await runner.query(`CREATE TABLE plugin_vibe_quant_status (
      id integer PRIMARY KEY CHECK (id = 1), payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }
  async down(runner: QueryRunner) {
    await runner.query(
      'DROP TABLE plugin_vibe_quant_status, plugin_vibe_quant_watchlist, plugin_vibe_quant_instruments',
    );
  }
}
class ManagedPython1792100001000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`UPDATE plugin_installations
      SET config = config - 'pythonPath', updated_at = now()
      WHERE id = 'vibe-quant' AND config ? 'pythonPath'`);
  }
  async down() {
    // The obsolete machine-specific path cannot be reconstructed safely.
  }
}
class TdxServerList1792100002000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    // Preserve an existing preferred endpoint at the front of the new list.
    const defaults =
      '110.41.147.114:7709\n8.129.13.54:7709\n124.70.176.52:7709\n47.100.236.28:7709\n121.36.54.217:7709\n124.71.85.110:7709\n106.14.201.131:7709\n123.60.70.228:7709';
    await runner.query(
      `UPDATE plugin_installations SET config = (config - 'tdxHost' - 'tdxPort') ||
      CASE WHEN NOT config ? 'tdxServers' AND trim(COALESCE(config->>'tdxHost', '')) <> ''
        THEN jsonb_build_object('tdxServers', trim(config->>'tdxHost') || ':' || COALESCE(config->>'tdxPort', '7709') || E'\\n' || $1::text)
        ELSE '{}'::jsonb END, updated_at = now()
      WHERE id = 'vibe-quant' AND (config ? 'tdxHost' OR config ? 'tdxPort')`,
      [defaults],
    );
  }
  async down() {
    // A list of endpoints cannot be represented by the obsolete single-host fields.
  }
}
export default {
  entities: [],
  migrations: [
    CreateVibeQuant1792100000000,
    ManagedPython1792100001000,
    TdxServerList1792100002000,
    StrategyManagement1792600000000,
  ],
} satisfies PluginDatabase;
