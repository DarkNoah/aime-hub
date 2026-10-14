import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePluginTables1780000014000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE plugin_installations (
      id text PRIMARY KEY, version text NOT NULL, enabled boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE TABLE plugin_migrations (
      plugin_id text NOT NULL, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (plugin_id, name)
    )`);
  }
  async down(runner: QueryRunner) {
    await runner.query('DROP TABLE plugin_migrations');
    await runner.query('DROP TABLE plugin_installations');
  }
}
