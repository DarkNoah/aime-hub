import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AutomationBotEvents1780000040000 implements MigrationInterface {
  name = 'AutomationBotEvents1780000040000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_events DROP CONSTRAINT group_chat_events_kind_check;
      ALTER TABLE group_chat_events ADD CONSTRAINT group_chat_events_kind_check CHECK (kind IN ('messages','task','plan','idle','issue','automation'))`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DELETE FROM group_chat_events WHERE kind='automation';
      ALTER TABLE group_chat_events DROP CONSTRAINT group_chat_events_kind_check;
      ALTER TABLE group_chat_events ADD CONSTRAINT group_chat_events_kind_check CHECK (kind IN ('messages','task','plan','idle','issue'))`);
  }
}
