import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProjectTables1780000002000 implements MigrationInterface {
  name = 'CreateProjectTables1780000002000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE projects (
      id text PRIMARY KEY,
      name text NOT NULL,
      created_by text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    )`);
    await queryRunner.query(`CREATE TABLE project_members (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      PRIMARY KEY (project_id, user_id)
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX project_members_owner ON project_members(project_id) WHERE role = 'owner' AND deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX project_members_user ON project_members(user_id, project_id) WHERE deleted_at IS NULL`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE project_members');
    await queryRunner.query('DROP TABLE projects');
  }
}
