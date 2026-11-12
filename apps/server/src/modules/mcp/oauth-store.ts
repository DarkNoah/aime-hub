import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { Pool } from 'pg';
import type { OAuthStorage } from '@mastra/mcp';
import { McpError } from './errors.js';

export type OAuthNamespace = {
  serverId: string;
  userId: string;
  generation: string;
};
export interface McpOAuthStore {
  ensure(
    serverId: string,
    binding: string,
    userId: string,
  ): Promise<OAuthNamespace>;
  namespace(
    serverId: string,
    binding: string,
    userId: string,
  ): Promise<OAuthNamespace | undefined>;
  storage(namespace: OAuthNamespace): OAuthStorage;
  rotate(namespace: OAuthNamespace): Promise<OAuthNamespace>;
  remove(serverId: string, userId?: string): Promise<void>;
  saveSession(
    state: string,
    serverId: string,
    userId: string,
    payload: string,
  ): Promise<void>;
  consumeSession(state: string, userId: string): Promise<string | undefined>;
}

/** OAuth secrets never enter MCP configuration metadata or API responses. */
export class PgMcpOAuthStore implements McpOAuthStore {
  private readonly key: Buffer;
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    secret: string,
  ) {
    this.key = Buffer.from(
      hkdfSync('sha256', secret, '', 'mcp-oauth-storage-v1', 32),
    );
  }

  private encrypt(value: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    );
  }

  private decrypt(value: string, context: string) {
    try {
      const data = Buffer.from(value, 'base64');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        data.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new McpError('MCP_OAUTH_STORAGE_FAILED', 500);
    }
  }

  async ensure(
    serverId: string,
    binding: string,
    userId: string,
  ): Promise<OAuthNamespace> {
    const { rows } = await this.pool.query<{ generation: string }>(
      `INSERT INTO mcp_oauth_credentials (server_id, binding, generation, user_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (server_id, user_id) DO UPDATE SET
         generation = CASE WHEN mcp_oauth_credentials.binding = EXCLUDED.binding THEN mcp_oauth_credentials.generation ELSE EXCLUDED.generation END,
         data = CASE WHEN mcp_oauth_credentials.binding = EXCLUDED.binding THEN mcp_oauth_credentials.data ELSE '{}'::jsonb END,
         binding = EXCLUDED.binding RETURNING generation`,
      [serverId, binding, randomUUID(), userId],
    );
    return { serverId, userId, generation: rows[0].generation };
  }

  async namespace(
    serverId: string,
    binding: string,
    userId: string,
  ): Promise<OAuthNamespace | undefined> {
    const { rows } = await this.pool.query<{ generation: string }>(
      'SELECT generation FROM mcp_oauth_credentials WHERE server_id = $1 AND binding = $2 AND user_id = $3',
      [serverId, binding, userId],
    );
    return rows[0]
      ? { serverId, userId, generation: rows[0].generation }
      : undefined;
  }

  async rotate({
    serverId,
    userId,
    generation,
  }: OAuthNamespace): Promise<OAuthNamespace> {
    const next = randomUUID();
    const result = await this.pool.query(
      "UPDATE mcp_oauth_credentials SET generation = $3, data = '{}'::jsonb WHERE server_id = $1 AND generation = $2 AND user_id = $4",
      [serverId, generation, next, userId],
    );
    if (!result.rowCount) throw new McpError('MCP_CONFLICT', 409);
    return { serverId, userId, generation: next };
  }

  storage({ serverId, userId, generation }: OAuthNamespace): OAuthStorage {
    const context = (key: string) =>
      `${serverId}:${userId}:${generation}:${key}`;
    return {
      get: async (key) => {
        const { rows } = await this.pool.query<{ value: string | null }>(
          'SELECT data ->> $3 AS value FROM mcp_oauth_credentials WHERE server_id = $1 AND generation = $2 AND user_id = $4',
          [serverId, generation, key, userId],
        );
        if (!rows.length) throw new McpError('MCP_CONFLICT', 409);
        return rows[0].value
          ? this.decrypt(rows[0].value, context(key))
          : undefined;
      },
      set: async (key, value) => {
        const result = await this.pool.query(
          'UPDATE mcp_oauth_credentials SET data = jsonb_set(data, ARRAY[$3]::text[], to_jsonb($4::text)) WHERE server_id = $1 AND generation = $2 AND user_id = $5',
          [
            serverId,
            generation,
            key,
            this.encrypt(value, context(key)),
            userId,
          ],
        );
        if (!result.rowCount) throw new McpError('MCP_CONFLICT', 409);
      },
      delete: async (key) => {
        await this.pool.query(
          'UPDATE mcp_oauth_credentials SET data = data - $3::text WHERE server_id = $1 AND generation = $2 AND user_id = $4',
          [serverId, generation, key, userId],
        );
      },
    };
  }

  async remove(serverId: string, userId?: string) {
    await this.pool.query(
      'DELETE FROM mcp_oauth_credentials WHERE server_id = $1 AND ($2::text IS NULL OR user_id = $2)',
      [serverId, userId ?? null],
    );
  }

  async saveSession(
    state: string,
    serverId: string,
    userId: string,
    payload: string,
  ) {
    const hash = createHash('sha256').update(state).digest('hex');
    await this.pool.query(
      'DELETE FROM mcp_oauth_sessions WHERE expires_at < now() OR (server_id = $1 AND user_id = $2)',
      [serverId, userId],
    );
    await this.pool.query(
      "INSERT INTO mcp_oauth_sessions (state_hash, server_id, user_id, expires_at, payload) VALUES ($1, $2, $3, now() + interval '10 minutes', $4)",
      [
        hash,
        serverId,
        userId,
        this.encrypt(payload, `session:${hash}:${userId}`),
      ],
    );
  }

  async consumeSession(state: string, userId: string) {
    const hash = createHash('sha256').update(state).digest('hex');
    const { rows } = await this.pool.query<{ payload: string }>(
      'DELETE FROM mcp_oauth_sessions WHERE state_hash = $1 AND user_id = $2 AND expires_at > now() RETURNING payload',
      [hash, userId],
    );
    return rows[0]
      ? this.decrypt(rows[0].payload, `session:${hash}:${userId}`)
      : undefined;
  }
}
