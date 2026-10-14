import type { DataSource } from 'typeorm';
import type { PluginManifest } from '@app/plugin-sdk';
import type { PluginDatabase } from '@app/plugin-sdk/server';

export async function migratePlugins(
  database: DataSource,
  plugins: readonly { manifest: PluginManifest; database: PluginDatabase }[],
) {
  const runner = database.createQueryRunner();
  await runner.connect();
  let applied = 0;
  try {
    await runner.startTransaction();
    await runner.query(
      "SELECT pg_advisory_xact_lock(hashtext('host-plugin-migrations'))",
    );
    for (const plugin of plugins) {
      const current = await runner.query(
        'SELECT version FROM plugin_installations WHERE id = $1',
        [plugin.manifest.id],
      );
      if (current[0]) {
        const old = current[0].version.split('.').map(Number);
        const next = plugin.manifest.version.split('.').map(Number);
        const changed = next.findIndex((part, index) => part !== old[index]);
        if (changed >= 0 && next[changed] < old[changed])
          throw new Error(
            `PLUGIN_DOWNGRADE_UNSUPPORTED: ${plugin.manifest.id}`,
          );
      }
      const names = new Set<string>();
      for (const Migration of plugin.database.migrations) {
        const migration = new Migration();
        const name = migration.name ?? Migration.name;
        if (!name || names.has(name))
          throw new Error(`Duplicate migration: ${plugin.manifest.id}/${name}`);
        names.add(name);
        const rows = await runner.query(
          'SELECT name FROM plugin_migrations WHERE plugin_id = $1 AND name = $2',
          [plugin.manifest.id, name],
        );
        if (rows.length) continue;
        await migration.up(runner);
        await runner.query(
          'INSERT INTO plugin_migrations (plugin_id, name) VALUES ($1, $2)',
          [plugin.manifest.id, name],
        );
        applied++;
      }
      // New installations are disabled. Upgrades preserve the administrator's choice.
      await runner.query(
        `INSERT INTO plugin_installations (id, version) VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, updated_at = now()`,
        [plugin.manifest.id, plugin.manifest.version],
      );
    }
    await runner.commitTransaction();
    return applied;
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}
