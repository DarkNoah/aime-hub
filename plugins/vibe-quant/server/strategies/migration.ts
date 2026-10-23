import type { MigrationInterface, QueryRunner } from 'typeorm';

export class StrategyManagement1792600000000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE plugin_vibe_quant_sources (
      hash text PRIMARY KEY, source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE TABLE plugin_vibe_quant_strategies (
      id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL, description text NOT NULL, enabled boolean NOT NULL DEFAULT true,
      revision integer NOT NULL DEFAULT 1, version_count integer NOT NULL DEFAULT 0,
      draft_hash text NOT NULL REFERENCES plugin_vibe_quant_sources(hash),
      draft_entrypoint text NOT NULL, draft_parameters jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(
      `CREATE INDEX ON plugin_vibe_quant_strategies (user_id, updated_at DESC)`,
    );
    await runner.query(`CREATE TABLE plugin_vibe_quant_versions (
      id uuid PRIMARY KEY, strategy_id uuid NOT NULL REFERENCES plugin_vibe_quant_strategies(id) ON DELETE CASCADE,
      number integer NOT NULL, source_hash text NOT NULL REFERENCES plugin_vibe_quant_sources(hash),
      entrypoint text NOT NULL, parameters jsonb NOT NULL, note text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (strategy_id, number)
    )`);
    await runner.query(`CREATE TABLE plugin_vibe_quant_runs (
      id uuid PRIMARY KEY, strategy_id uuid NOT NULL REFERENCES plugin_vibe_quant_strategies(id) ON DELETE CASCADE,
      version_id uuid NOT NULL REFERENCES plugin_vibe_quant_versions(id), engine text NOT NULL,
      status text NOT NULL DEFAULT 'queued', message text NOT NULL DEFAULT '', config jsonb NOT NULL,
      cancel_requested boolean NOT NULL DEFAULT false, worker_id uuid, heartbeat_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
    )`);
    await runner.query(
      `CREATE INDEX ON plugin_vibe_quant_runs (strategy_id, created_at DESC)`,
    );
    await runner.query(
      `CREATE INDEX ON plugin_vibe_quant_runs (status, heartbeat_at)`,
    );
    await runner.query(`CREATE TABLE plugin_vibe_quant_run_artifacts (
      run_id uuid NOT NULL REFERENCES plugin_vibe_quant_runs(id) ON DELETE CASCADE,
      kind text NOT NULL, hash text NOT NULL, data bytea NOT NULL,
      PRIMARY KEY (run_id, kind)
    )`);
  }
  async down(runner: QueryRunner) {
    await runner.query(
      'DROP TABLE plugin_vibe_quant_run_artifacts, plugin_vibe_quant_runs, plugin_vibe_quant_versions, plugin_vibe_quant_strategies, plugin_vibe_quant_sources',
    );
  }
}
