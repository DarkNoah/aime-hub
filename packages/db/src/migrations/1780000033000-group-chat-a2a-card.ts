import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatA2aCard1780000033000 implements MigrationInterface {
  name = 'GroupChatA2aCard1780000033000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_a2a_members
      ADD COLUMN public_origin text,
      ADD COLUMN description text NOT NULL DEFAULT ''`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_a2a_members
      DROP COLUMN description,
      DROP COLUMN public_origin`);
  }
}
