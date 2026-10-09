import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProjectListState1780000003000 implements MigrationInterface {
  name = 'ProjectListState1780000003000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE projects ADD COLUMN archived boolean NOT NULL DEFAULT false',
    );
    await queryRunner.query(
      'ALTER TABLE project_members ADD COLUMN pinned boolean NOT NULL DEFAULT false',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE project_members DROP COLUMN pinned');
    await queryRunner.query('ALTER TABLE projects DROP COLUMN archived');
  }
}
