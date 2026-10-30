import type { DataSource } from 'typeorm';
import { hasAdminRole } from '@aime/shared';
import {
  pluginAccessSchema,
  type PluginAccess,
  type PluginAccessConfiguration,
} from '@app/plugin-sdk';

export class PluginAccessError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

type AccessRow = { id: string; access: PluginAccess; revision: string };

/** Access revisions are independent of runtime configuration: grants do not restart plugins. */
export class PluginAccessService {
  constructor(private readonly database: DataSource) {}

  private async rows(id?: string): Promise<AccessRow[]> {
    return this.database.query(
      `SELECT id, access, access_revision::text AS revision FROM plugin_installations${id ? ' WHERE id = $1' : ''}`,
      id ? [id] : [],
    );
  }

  async allowedIds(userId?: string): Promise<Set<string>> {
    const rows = await this.rows();
    const policies = rows.map((row) => ({
      id: row.id,
      access: pluginAccessSchema.parse(row.access),
    }));
    let admin = false;
    if (userId && policies.some(({ access }) => access.mode === 'selected')) {
      const [user] = await this.database.query<
        { role: string | null; banned: boolean | null }[]
      >('SELECT role, banned FROM users WHERE id = $1', [userId]);
      admin = !!user && !user.banned && hasAdminRole(user.role);
    }
    return new Set(
      policies
        .filter(
          ({ access }) =>
            admin ||
            access.mode === 'all' ||
            (!!userId && access.userIds.includes(userId)),
        )
        .map(({ id }) => id),
    );
  }

  async assertAllowed(id: string, userId?: string) {
    if (!(await this.allowedIds(userId)).has(id))
      throw new PluginAccessError('PLUGIN_FORBIDDEN', 403);
  }

  async get(id: string): Promise<PluginAccessConfiguration> {
    const [row] = await this.rows(id);
    if (!row) throw new PluginAccessError('PLUGIN_NOT_FOUND', 404);
    return {
      access: pluginAccessSchema.parse(row.access),
      revision: row.revision,
    };
  }

  async save(
    id: string,
    input: PluginAccessConfiguration,
  ): Promise<PluginAccessConfiguration> {
    const access = pluginAccessSchema.parse(input.access);
    access.userIds =
      access.mode === 'all' ? [] : [...new Set(access.userIds)].sort();
    if (access.userIds.length) {
      const users = await this.database.query<{ id: string }[]>(
        'SELECT id FROM users WHERE id = ANY($1::text[])',
        [access.userIds],
      );
      if (users.length !== access.userIds.length)
        throw new PluginAccessError('PLUGIN_ACCESS_USER_NOT_FOUND', 400);
    }
    const [row] = await this.database.query<AccessRow[]>(
      `WITH updated AS (
         UPDATE plugin_installations SET access = $2::jsonb, access_revision = access_revision + 1
         WHERE id = $1 AND access_revision::text = $3
         RETURNING access, access_revision
       ) SELECT access, access_revision::text AS revision FROM updated`,
      [id, JSON.stringify(access), input.revision],
    );
    if (!row) {
      await this.get(id);
      throw new PluginAccessError('PLUGIN_ACCESS_CONFLICT', 409);
    }
    return { access: row.access, revision: row.revision };
  }
}
