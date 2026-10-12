import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestLogResponse1780000007000 implements MigrationInterface {
  name = 'AddRequestLogResponse1780000007000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chat_request_logs
        ADD COLUMN duration_ms double precision CHECK (duration_ms >= 0),
        ADD COLUMN http_status integer,
        ADD COLUMN response_status text CHECK (response_status IN ('pending', 'complete', 'incomplete')),
        ADD COLUMN response_content_type text,
        ADD COLUMN response_content_encoding text,
        ADD COLUMN response_bytes integer CHECK (response_bytes >= 0),
        ADD COLUMN response_body_encoding text CHECK (response_body_encoding IN ('utf8', 'base64')),
        ADD COLUMN response_body text
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chat_request_logs
        DROP COLUMN response_body,
        DROP COLUMN response_body_encoding,
        DROP COLUMN response_bytes,
        DROP COLUMN response_content_encoding,
        DROP COLUMN response_content_type,
        DROP COLUMN response_status,
        DROP COLUMN http_status,
        DROP COLUMN duration_ms
    `);
  }
}
