import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatChoices1780000034000 implements MigrationInterface {
  name = 'GroupChatChoices1780000034000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_messages
      ADD COLUMN choices jsonb,
      ADD COLUMN choice_response jsonb`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_messages
      DROP COLUMN choice_response,
      DROP COLUMN choices`);
  }
}
