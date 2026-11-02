import { ORPCError } from '@orpc/server';
import { hasAdminRole } from '@aime/shared';
import type { DataSource } from 'typeorm';
import type { PluginService } from '../plugins/service.js';

/** Plugin grants bound invitations and ongoing room access; room invitations never grant plugin access. */
export class PluginRoomAccess {
  constructor(
    private database: DataSource,
    private plugins: Pick<PluginService, 'list' | 'access'>,
  ) {}

  async enabledIds(
    userId?: string,
    reader: Pick<DataSource, 'query'> = this.database,
  ): Promise<string[]> {
    const plugins = await this.plugins.list(reader);
    const allowed = userId
      ? await this.plugins.access.allowedIds(userId, reader)
      : null;
    return plugins
      .filter(
        (plugin) =>
          plugin.enabled &&
          plugin.groupChat &&
          plugin.workspace &&
          (!allowed || allowed.has(plugin.id)),
      )
      .map((plugin) => plugin.id);
  }

  async assertAccess(
    pluginId: string,
    userId: string,
    reader: Pick<DataSource, 'query'> = this.database,
  ) {
    if (!(await this.enabledIds(userId, reader)).includes(pluginId))
      throw new ORPCError('NOT_FOUND');
  }

  async isAdmin(
    userId: string,
    reader: Pick<DataSource, 'query'> = this.database,
  ) {
    const [user] = await reader.query(
      'SELECT role,banned FROM users WHERE id=$1',
      [userId],
    );
    return !!user && !user.banned && hasAdminRole(user.role);
  }

  async candidateIds(
    pluginId: string,
    reader: Pick<DataSource, 'query'> = this.database,
  ): Promise<string[] | null> {
    const { access } = await this.plugins.access.get(pluginId, reader);
    return access.mode === 'all' ? null : access.userIds;
  }

  async assertCandidate(
    pluginId: string,
    userId: string,
    reader: Pick<DataSource, 'query'> = this.database,
  ) {
    const allowed = await this.candidateIds(pluginId, reader);
    if (allowed && !allowed.includes(userId)) throw new ORPCError('FORBIDDEN');
  }

  async filterMembers(
    pluginId: string,
    members: { userId: string }[],
    reader: Pick<DataSource, 'query'> = this.database,
  ) {
    const allowed = await this.candidateIds(pluginId, reader);
    const users: { id: string; role: string | null }[] = await reader.query(
      'SELECT id,role FROM users WHERE id=ANY($1::text[]) AND NOT COALESCE(banned,false)',
      [members.map((member) => member.userId)],
    );
    const selected = new Set(allowed);
    const visible = new Set(
      users
        .filter(
          (user) =>
            !allowed || selected.has(user.id) || hasAdminRole(user.role),
        )
        .map((user) => user.id),
    );
    return members.filter((member) => visible.has(member.userId));
  }
}
