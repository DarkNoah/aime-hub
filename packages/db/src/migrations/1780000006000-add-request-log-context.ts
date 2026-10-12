import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestLogContext1780000006000 implements MigrationInterface {
  name = 'AddRequestLogContext1780000006000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chat_request_logs
        ADD COLUMN thread_id text,
        ADD COLUMN resource_id text,
        ADD COLUMN user_id text,
        ADD COLUMN project_id text
    `);
    for (const column of [
      'thread_id',
      'resource_id',
      'user_id',
      'project_id',
    ]) {
      await queryRunner.query(
        `CREATE INDEX chat_request_logs_${column}_created_at_id_idx ON chat_request_logs (${column}, created_at DESC, id DESC)`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE chat_request_logs
        DROP COLUMN project_id,
        DROP COLUMN user_id,
        DROP COLUMN resource_id,
        DROP COLUMN thread_id
    `);
  }
}
