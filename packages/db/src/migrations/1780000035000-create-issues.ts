import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIssues1780000035000 implements MigrationInterface {
  name = 'CreateIssues1780000035000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE issues (
      id serial PRIMARY KEY,
      project_id text REFERENCES projects(id) ON DELETE CASCADE,
      created_by text NOT NULL,
      thread_id text NOT NULL UNIQUE,
      title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
      body text NOT NULL DEFAULT '' CHECK (length(body) <= 50000),
      state text NOT NULL DEFAULT 'todo' CHECK (state IN ('decision','todo','in_progress','done')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz,
      CHECK ((state = 'done') = (closed_at IS NOT NULL))
    )`);
    await queryRunner.query(
      'CREATE INDEX issues_personal ON issues(created_by,state,id DESC) WHERE project_id IS NULL',
    );
    await queryRunner.query(
      'CREATE INDEX issues_project ON issues(project_id,state,id DESC) WHERE project_id IS NOT NULL',
    );
    await queryRunner.query(`CREATE TABLE issue_comments (
      id text PRIMARY KEY,
      sequence bigserial NOT NULL UNIQUE,
      issue_id integer NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      author_id text NOT NULL,
      body text NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 50000),
      kind text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','message')),
      delivery text CHECK (delivery IN ('wait','immediate')),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(
      'CREATE INDEX issue_comments_history ON issue_comments(issue_id,sequence DESC)',
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE issue_comments');
    await queryRunner.query('DROP TABLE issues');
  }
}
