import { TABLE_AGENTS, TABLE_AGENT_VERSIONS } from '@mastra/core/storage';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export type AgentSkillReferenceMigration = {
  scope: 'global' | 'personal' | 'project';
  /** Stable ID from the filesystem migration journal, reused after a retry. */
  migrationId: string;
  /** Exact installed entry paths, relative to the skills root of this scope. */
  paths: ReadonlyMap<string, string>;
};

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const validPath = (value: string) =>
  !!value &&
  !/[\\\0]/.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');

/**
 * Admin Agent selections always pin global installations, including shared global
 * entries. Personal/project moves must never rewrite a same-named global pin.
 * Run after native storage initialization and before serving Agent mutations.
 */
export async function migrateAgentSkillReferences(
  pool: Pick<Pool, 'connect'>,
  migration: AgentSkillReferenceMigration,
  schema = 'mastra',
) {
  const result = { agents: 0, versions: 0, references: 0 };
  if (migration.scope !== 'global') return result;
  const paths = new Map(
    [...migration.paths].filter(([previous, next]) => previous !== next),
  );
  if (!paths.size) return result;
  for (const [previous, next] of paths) {
    if (!validPath(previous) || !validPath(next))
      throw new Error('Invalid Agent skill reference migration path');
  }
  if (!migration.migrationId || migration.migrationId.includes('\0'))
    throw new Error('Invalid Agent skill reference migration ID');
  if (!schema || schema.includes('\0'))
    throw new Error('Invalid Agent storage schema');
  const agents = `${identifier(schema)}.${identifier(TABLE_AGENTS)}`;
  const versions = `${identifier(schema)}.${identifier(TABLE_AGENT_VERSIONS)}`;
  const key = `skills:agent-path-migration:${migration.migrationId}`;
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        schema,
        [...paths].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    )
    .digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Claim the journal in the same transaction as the reference updates. This
    // also serializes concurrent retries when a destination is another old path.
    const claimed = await client.query(
      'INSERT INTO "settings" (id, value) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id',
      [key, JSON.stringify({ version: 1, fingerprint })],
    );
    if (!claimed.rowCount) {
      const existing = await client.query<{ value: { fingerprint?: string } }>(
        'SELECT value FROM "settings" WHERE id = $1',
        [key],
      );
      if (existing.rows[0]?.value?.fingerprint !== fingerprint)
        throw new Error('Agent skill reference migration journal mismatch');
      await client.query('COMMIT');
      return result;
    }
    // Native storage has no updateVersion API. Updating only this JSON leaf
    // preserves published/draft history, IDs, version numbers and timestamps.
    const { rows } = await client.query<{
      id: string;
      agentId: string;
      paths: unknown[];
    }>(`
      SELECT version.id, version."agentId", version.workspace #> '{config,skillPaths}' AS paths
      FROM ${versions} AS version
      JOIN ${agents} AS agent ON agent.id = version."agentId"
      WHERE agent.metadata ->> 'managedBy' = 'admin-agents'
        AND agent.metadata -> 'configVersion' = '1'::jsonb
        AND version.workspace ->> 'type' = 'provider'
        AND version.workspace ->> 'provider' = 'installed-skills'
        AND jsonb_typeof(version.workspace #> '{config,skillPaths}') = 'array'
      FOR UPDATE OF version
    `);
    const affected = new Set<string>();
    for (const row of rows) {
      // Do not silently repair malformed/foreign snapshots as part of a path move.
      if (!row.paths.every((path) => typeof path === 'string')) continue;
      let changed = 0;
      const migrated = row.paths.map((path) => {
        const next = paths.get(path as string);
        if (next === undefined) return path as string;
        changed++;
        return next;
      });
      if (!changed) continue;
      await client.query(
        `UPDATE ${versions}
         SET workspace = jsonb_set(workspace, '{config,skillPaths}', $1::jsonb)
         WHERE id = $2`,
        [JSON.stringify([...new Set(migrated)]), row.id],
      );
      affected.add(row.agentId);
      result.versions++;
      result.references += changed;
    }
    await client.query('COMMIT');
    result.agents = affected.size;
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
