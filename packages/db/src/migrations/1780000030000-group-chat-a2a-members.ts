import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatA2aMembers1780000030000 implements MigrationInterface {
  name = 'GroupChatA2aMembers1780000030000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE group_chat_a2a_members (
      id text PRIMARY KEY,
      room_id text NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      name text NOT NULL,
      key_hash text NOT NULL UNIQUE,
      key_prefix text NOT NULL,
      created_by text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz,
      CHECK (revoked_at IS NULL OR NOT enabled)
    )`);
    await runner.query(
      'CREATE INDEX group_chat_a2a_members_room ON group_chat_a2a_members(room_id,created_at,id)',
    );
    await runner.query(`ALTER TABLE group_chat_messages DROP CONSTRAINT group_chat_messages_sender_kind_check;
      ALTER TABLE group_chat_messages ADD CONSTRAINT group_chat_messages_sender_kind_check CHECK (sender_kind IN ('user','agent','a2a'))`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Preserve independent sender IDs and historical messages when rolling back.
    await runner.query(`UPDATE group_chat_messages SET sender_kind='agent' WHERE sender_kind='a2a';
      ALTER TABLE group_chat_messages DROP CONSTRAINT group_chat_messages_sender_kind_check;
      ALTER TABLE group_chat_messages ADD CONSTRAINT group_chat_messages_sender_kind_check CHECK (sender_kind IN ('user','agent'));
      DROP TABLE group_chat_a2a_members`);
  }
}
