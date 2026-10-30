import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PluginAccess1780000025000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`ALTER TABLE plugin_installations
      ADD COLUMN access jsonb NOT NULL DEFAULT '{"mode":"all","userIds":[]}'::jsonb,
      ADD COLUMN access_revision bigint NOT NULL DEFAULT 0`);
  }

  async down(runner: QueryRunner) {
    await runner.query(`ALTER TABLE plugin_installations
      DROP COLUMN access, DROP COLUMN access_revision`);
  }
}
