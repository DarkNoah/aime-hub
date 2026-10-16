import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PluginConfiguration1780000022000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`ALTER TABLE plugin_installations
      ADD COLUMN config jsonb NOT NULL DEFAULT '{}'::jsonb
      CHECK (jsonb_typeof(config) = 'object')`);
  }

  async down(runner: QueryRunner) {
    await runner.query('ALTER TABLE plugin_installations DROP COLUMN config');
  }
}
