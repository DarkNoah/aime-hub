import type { MigrationInterface, QueryRunner } from 'typeorm';

export class IssueEvents1780000038000 implements MigrationInterface {
  name = 'IssueEvents1780000038000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_events DROP CONSTRAINT group_chat_events_kind_check;
      ALTER TABLE group_chat_events ADD CONSTRAINT group_chat_events_kind_check CHECK (kind IN ('messages','task','plan','idle','issue'))`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DELETE FROM group_chat_events WHERE kind='issue';
      ALTER TABLE group_chat_events DROP CONSTRAINT group_chat_events_kind_check;
      ALTER TABLE group_chat_events ADD CONSTRAINT group_chat_events_kind_check CHECK (kind IN ('messages','task','plan','idle'))`);
  }
}
