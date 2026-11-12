import type { MigrationInterface, QueryRunner } from 'typeorm';

export class McpOAuth1780000044000 implements MigrationInterface {
  name = 'McpOAuth1780000044000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE mcp_oauth_credentials (
      server_id uuid NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      binding text NOT NULL,
      generation uuid NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (server_id, user_id)
    )`);
    await runner.query(`CREATE TABLE mcp_oauth_sessions (
      state_hash text PRIMARY KEY,
      server_id uuid NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      payload text NOT NULL,
      FOREIGN KEY (server_id, user_id) REFERENCES mcp_oauth_credentials(server_id, user_id) ON DELETE CASCADE
    )`);
    await runner.query(
      'CREATE INDEX mcp_oauth_sessions_expiry ON mcp_oauth_sessions(expires_at)',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE mcp_oauth_sessions');
    await runner.query('DROP TABLE mcp_oauth_credentials');
  }
}
