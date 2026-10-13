import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsageRecords1780000012000 implements MigrationInterface {
  name = 'CreateUsageRecords1780000012000';
  async up(query: QueryRunner): Promise<void> {
    await query.query(`CREATE TABLE usage_records (
      id uuid PRIMARY KEY, created_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
      user_id text NOT NULL, project_id text, thread_id text NOT NULL, run_id text, agent_id text,
      step_number integer NOT NULL, provider_id text, model text NOT NULL, model_reference text NOT NULL,
      finish_reason text, duration_ms double precision NOT NULL CHECK (duration_ms >= 0),
      input_tokens bigint CHECK (input_tokens >= 0), output_tokens bigint CHECK (output_tokens >= 0),
      total_tokens bigint CHECK (total_tokens >= 0), cached_input_tokens bigint CHECK (cached_input_tokens >= 0),
      cache_creation_input_tokens bigint CHECK (cache_creation_input_tokens >= 0), reasoning_tokens bigint CHECK (reasoning_tokens >= 0)
    )`);
    await query.query(
      'CREATE INDEX usage_records_created_idx ON usage_records (created_at, id)',
    );
    await query.query(
      'CREATE INDEX usage_records_user_created_idx ON usage_records (user_id, created_at)',
    );
    await query.query(
      'CREATE INDEX usage_records_project_created_idx ON usage_records (project_id, created_at)',
    );
    await query.query(
      'CREATE INDEX usage_records_model_created_idx ON usage_records (provider_id, model, created_at)',
    );
  }
  async down(query: QueryRunner): Promise<void> {
    await query.query('DROP TABLE usage_records');
  }
}
