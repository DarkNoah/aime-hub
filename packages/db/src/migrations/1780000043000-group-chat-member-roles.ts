import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatMemberRoles1780000043000 implements MigrationInterface {
  name = 'GroupChatMemberRoles1780000043000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_members
      ADD COLUMN role text NOT NULL DEFAULT 'member'
      CHECK (role IN ('admin', 'member'))`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE group_chat_members DROP COLUMN role');
  }
}
