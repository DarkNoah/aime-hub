import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateGroupChats1780000024000 implements MigrationInterface {
  name = 'CreateGroupChats1780000024000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE group_chats (
      id text PRIMARY KEY,
      title text NOT NULL,
      project_id text REFERENCES projects(id) ON DELETE CASCADE,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(
      `CREATE INDEX group_chats_personal ON group_chats(created_by, created_at DESC, id DESC) WHERE project_id IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX group_chats_project ON group_chats(project_id, created_at DESC, id DESC) WHERE project_id IS NOT NULL`,
    );
    await queryRunner.query(`CREATE TABLE group_chat_messages (
      room_id text NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
      id text NOT NULL,
      sequence bigserial NOT NULL UNIQUE,
      sender_id text NOT NULL,
      text text NOT NULL CHECK (length(btrim(text)) > 0 AND length(text) <= 20000),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, id)
    )`);
    await queryRunner.query(
      `CREATE INDEX group_chat_messages_history ON group_chat_messages(room_id, sequence DESC)`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE group_chat_messages');
    await queryRunner.query('DROP TABLE group_chats');
  }
}
