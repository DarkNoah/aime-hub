import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatA2aMemberDeletion1780000031000 implements MigrationInterface {
  name = 'GroupChatA2aMemberDeletion1780000031000';

  async up(runner: QueryRunner): Promise<void> {
    // Keep the identity row so existing messages still resolve their author.
    await runner.query(`ALTER TABLE group_chat_a2a_members
      ADD COLUMN deleted_at timestamptz,
      ADD CONSTRAINT group_chat_a2a_members_deleted_check
        CHECK (deleted_at IS NULL OR (NOT enabled AND revoked_at IS NOT NULL))`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE group_chat_a2a_members
      DROP CONSTRAINT group_chat_a2a_members_deleted_check,
      DROP COLUMN deleted_at`);
  }
}
