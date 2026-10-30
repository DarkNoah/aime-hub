import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GroupChatReads1780000032000 implements MigrationInterface {
  name = 'GroupChatReads1780000032000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE group_chat_reads (
      room_id text NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
      PRIMARY KEY (room_id, user_id)
    )`);
    await runner.query(
      'CREATE INDEX group_chat_reads_user ON group_chat_reads(user_id,room_id)',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE group_chat_reads');
  }
}
