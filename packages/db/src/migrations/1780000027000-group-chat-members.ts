import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatMembers1780000027000 implements MigrationInterface {
  name = 'GroupChatMembers1780000027000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE group_chat_members (
      room_id text NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, user_id)
    )`);
    await runner.query(
      'CREATE INDEX group_chat_members_user ON group_chat_members(user_id,room_id)',
    );
    await runner.query(`UPDATE group_chat_agents SET enabled=true,status='idle',error=NULL
      WHERE role='bot' AND NOT enabled AND NOT deleting`);
    await runner.query(`ALTER TABLE group_chat_agents ADD CONSTRAINT group_chat_bot_enabled
      CHECK (role <> 'bot' OR enabled OR deleting)`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE group_chat_agents DROP CONSTRAINT group_chat_bot_enabled',
    );
    await runner.query('DROP TABLE group_chat_members');
  }
}
