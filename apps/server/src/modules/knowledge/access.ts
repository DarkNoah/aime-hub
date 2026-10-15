import {
  KnowledgeBaseRecord as Base,
  KnowledgeBaseMember as Member,
} from '@aime/db';
import { hasAdminRole } from '@aime/shared';
import type { KnowledgeBase, KnowledgeScope } from '@aime/shared/knowledge';
import type { DataSource, EntityManager } from 'typeorm';
import type { ProjectThreadAccess } from '../projects/service.js';
import { ThreadError } from '../threads/errors.js';

export type KnowledgeCapabilities = Pick<
  KnowledgeBase,
  'canManage' | 'canEditDocuments' | 'canDelete' | 'canShare' | 'permission'
>;
export type KnowledgeAction = 'documents' | 'manage' | 'delete' | 'share';
export class KnowledgeAccess {
  constructor(
    private database: DataSource,
    private projects: ProjectThreadAccess,
  ) {}
  async canCreate(userId: string, scope: KnowledgeScope) {
    if (scope.scope === 'personal') return true;
    if (scope.scope === 'project')
      return ['owner', 'admin'].includes(
        (await this.projects.assertMember(userId, scope.projectId)).role,
      );
    const users = await this.database.query(
      'SELECT role FROM users WHERE id = $1 AND COALESCE(banned, false) = false',
      [userId],
    );
    return hasAdminRole(users[0]?.role);
  }
  async permissions(
    userId: string,
    base: Base,
    manager: EntityManager,
  ): Promise<KnowledgeCapabilities> {
    const owner = base.ownerId === userId;
    let manage = owner;
    let permission: KnowledgeBase['permission'];
    if (base.scope === 'project') {
      const member = await this.projects.assertMember(userId, base.projectId!);
      manage = owner || ['owner', 'admin'].includes(member.role);
      permission = owner ? 'owner' : manage ? 'edit' : 'read';
    } else if (owner) permission = 'owner';
    else if (base.sharingMode === 'all') permission = base.sharedPermission;
    else if (base.sharingMode === 'members') {
      const member = await manager.findOneBy(Member, {
        baseId: base.id,
        userId,
      });
      if (!member) throw new ThreadError('KNOWLEDGE_NOT_FOUND', 404);
      permission = member.permission;
    } else throw new ThreadError('KNOWLEDGE_NOT_FOUND', 404);
    return {
      permission,
      canManage: manage,
      canEditDocuments: permission !== 'read',
      canDelete: owner,
      canShare: owner && base.scope !== 'project',
    };
  }
  async access(
    userId: string,
    id: string,
    action?: KnowledgeAction,
    manager = this.database.manager,
  ) {
    const base = await manager.findOneBy(Base, { id });
    if (!base) throw new ThreadError('KNOWLEDGE_NOT_FOUND', 404);
    const permissions = await this.permissions(userId, base, manager);
    const allowed =
      action === 'documents'
        ? permissions.canEditDocuments
        : action === 'manage'
          ? permissions.canManage
          : action === 'delete'
            ? permissions.canDelete
            : action === 'share'
              ? permissions.canShare
              : true;
    if (!allowed) throw new ThreadError('FORBIDDEN', 403);
    return { base, ...permissions };
  }
  async list(userId: string, scope: KnowledgeScope) {
    const canManage = await this.canCreate(userId, scope);
    const query = this.database.getRepository(Base).createQueryBuilder('b');
    if (scope.scope === 'personal')
      query.where("b.scope <> 'project' AND b.owner_id = :userId", { userId });
    else if (scope.scope === 'project')
      query.where("b.scope = 'project' AND b.project_id = :projectId", {
        projectId: scope.projectId,
      });
    else
      query.where(
        `b.scope <> 'project' AND (b.sharing_mode = 'all' OR
      (b.sharing_mode = 'members' AND (b.owner_id = :userId OR EXISTS (
        SELECT 1 FROM knowledge_base_members m WHERE m.base_id = b.id AND m.user_id = :userId))))`,
        { userId },
      );
    const bases = await query
      .orderBy('b.created_at', 'DESC')
      .addOrderBy('b.id', 'DESC')
      .getMany();
    return { bases, canManage };
  }
}
