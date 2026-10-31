import type { MigrationInterface, QueryRunner } from 'typeorm';

export class IssueOptionalThread1780000039000 implements MigrationInterface {
  name = 'IssueOptionalThread1780000039000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE issues ALTER COLUMN thread_id DROP NOT NULL',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse rollback while record-only Issues exist instead of deleting them.
    await queryRunner.query(
      'ALTER TABLE issues ALTER COLUMN thread_id SET NOT NULL',
    );
  }
}
