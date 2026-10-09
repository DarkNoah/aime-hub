import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateChatRequestLogs1780000005000 implements MigrationInterface {
  name = 'CreateChatRequestLogs1780000005000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE chat_request_logs (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL,
        method text NOT NULL,
        url text NOT NULL,
        model text,
        stream boolean,
        status text NOT NULL CHECK (status IN ('complete', 'incomplete')),
        body_bytes integer NOT NULL CHECK (body_bytes >= 0),
        body text NOT NULL
      )
    `);
    await queryRunner.query(
      'CREATE INDEX chat_request_logs_created_at_id_idx ON chat_request_logs (created_at DESC, id DESC)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE chat_request_logs');
  }
}
