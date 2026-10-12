import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateGeneratedAssets1780000009000 implements MigrationInterface {
  name = 'CreateGeneratedAssets1780000009000';

  async up(queryRunner: QueryRunner) {
    await queryRunner.query(`CREATE TABLE generated_assets (
      id uuid PRIMARY KEY,
      thread_id text NOT NULL,
      resource_id text NOT NULL,
      path text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
      mime_type text NOT NULL,
      size bigint NOT NULL CHECK (size >= 0),
      width integer CHECK (width > 0),
      height integer CHECK (height > 0),
      tool_name text NOT NULL,
      tool_call_id text,
      model text,
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      CONSTRAINT generated_assets_source_key UNIQUE (resource_id, thread_id, path)
    )`);
    await queryRunner.query(
      'CREATE INDEX generated_assets_resource_created_idx ON generated_assets (resource_id, created_at, id)',
    );
    await queryRunner.query(
      'CREATE INDEX generated_assets_thread_created_idx ON generated_assets (thread_id, created_at, id)',
    );
  }

  async down(queryRunner: QueryRunner) {
    await queryRunner.query('DROP TABLE generated_assets');
  }
}
