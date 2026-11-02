import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PluginGroupChats1780000042000 implements MigrationInterface {
  name = 'PluginGroupChats1780000042000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chats ADD COLUMN plugin_id text,
      ADD CONSTRAINT group_chats_scope CHECK (plugin_id IS NULL OR project_id IS NULL)`);
    await runner.query(`CREATE UNIQUE INDEX group_chats_plugin ON group_chats(plugin_id)
      WHERE plugin_id IS NOT NULL AND NOT deleting`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX group_chats_plugin');
    await runner.query(
      'ALTER TABLE group_chats DROP CONSTRAINT group_chats_scope, DROP COLUMN plugin_id',
    );
  }
}
