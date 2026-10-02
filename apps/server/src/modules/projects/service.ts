import { nanoid } from 'nanoid';
import type { DataSource, EntityManager } from 'typeorm';
import { Project, ProjectMember } from '@aime/db';
import type {
  ProjectDetail,
  ProjectList,
  ProjectRole,
  ProjectSummary,
  ProjectUser,
  ProjectMember as MemberSummary,
} from '@aime/shared/projects';
import { chatSettingsSchema, type ChatSettings } from '@aime/shared/threads';
import { ThreadError } from '../threads/errors.js';
import { requireMemberChange, requireProjectManager } from './permissions.js';

export interface ProjectThreadAccess {
  list?(userId: string, page?: number, perPage?: number): Promise<ProjectList>;
  assertMember(
    userId: string,
    projectId: string,
  ): Promise<{ role: ProjectRole }>;
}

function summary(project: Project, role: ProjectRole): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdBy: project.createdBy,
    role,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export class ProjectService implements ProjectThreadAccess {
  constructor(private database: DataSource) {}

  private async access(
    userId: string,
    projectId: string,
    manager = this.database.manager,
  ) {
    const [project, member] = await Promise.all([
      manager.findOneBy(Project, { id: projectId }),
      manager.findOneBy(ProjectMember, { projectId, userId }),
    ]);
    if (!project || !member) throw new ThreadError('PROJECT_NOT_FOUND', 404);
    return { project, role: member.role };
  }

  async assertMember(userId: string, projectId: string) {
    const { role } = await this.access(userId, projectId);
    return { role };
  }

  async get(userId: string, projectId: string): Promise<ProjectDetail> {
    const { project, role } = await this.access(userId, projectId);
    return {
      ...summary(project, role),
      settings: chatSettingsSchema.parse(project.metadata.chat ?? {}),
    };
  }

  async list(userId: string, page = 0, perPage = 20): Promise<ProjectList> {
    const projects = await this.database
      .getRepository(Project)
      .createQueryBuilder('project')
      .innerJoin(
        ProjectMember,
        'member',
        'member.project_id = project.id AND member.user_id = :userId AND member.deleted_at IS NULL',
        { userId },
      )
      .orderBy('project.updatedAt', 'DESC')
      .addOrderBy('project.id', 'DESC')
      .skip(page * perPage)
      .take(perPage + 1)
      .getMany();
    const members = await this.database.manager.findBy(ProjectMember, {
      userId,
    });
    const roles = new Map(
      members.map((member) => [member.projectId, member.role]),
    );
    return {
      projects: projects
        .slice(0, perPage)
        .map((project) => summary(project, roles.get(project.id)!)),
      page,
      hasMore: projects.length > perPage,
    };
  }

  async create(userId: string, input: { name: string }) {
    return this.database.transaction(async (manager) => {
      const project = await manager.save(
        Project,
        manager.create(Project, {
          id: nanoid(16),
          name: input.name,
          createdBy: userId,
          metadata: {},
        }),
      );
      await manager.save(
        ProjectMember,
        manager.create(ProjectMember, {
          projectId: project.id,
          userId,
          role: 'owner',
        }),
      );
      return {
        ...summary(project, 'owner'),
        settings: chatSettingsSchema.parse({}),
      };
    });
  }

  // Lock the project before changing roles or settings, including concurrent removal and deletion.
  private mutate<T>(
    userId: string,
    id: string,
    action: (
      manager: EntityManager,
      project: Project,
      role: ProjectRole,
    ) => Promise<T>,
  ) {
    return this.database.transaction(async (manager) => {
      const locked = await manager.findOne(Project, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new ThreadError('PROJECT_NOT_FOUND', 404);
      const { project, role } = await this.access(userId, id, manager);
      return action(manager, project, role);
    });
  }

  update(userId: string, id: string, input: { name: string }) {
    return this.mutate(userId, id, async (manager, project, role) => {
      requireProjectManager(role);
      project.name = input.name;
      return summary(await manager.save(project), role);
    });
  }

  remove(userId: string, id: string) {
    return this.mutate(userId, id, async (manager, project, role) => {
      if (role !== 'owner') throw new ThreadError('FORBIDDEN', 403);
      await manager.softDelete(ProjectMember, { projectId: id });
      await manager.softRemove(project);
    });
  }

  async preferences(userId: string, id: string) {
    return (await this.get(userId, id)).settings;
  }

  savePreferences(userId: string, id: string, settings: ChatSettings) {
    return this.mutate(userId, id, async (manager, project, role) => {
      requireProjectManager(role);
      project.metadata = { ...project.metadata, chat: settings };
      await manager.save(project);
      return settings;
    });
  }

  async members(userId: string, id: string): Promise<MemberSummary[]> {
    await this.assertMember(userId, id);
    const rows: Array<ProjectUser & { role: ProjectRole; createdAt: Date }> =
      await this.database.query(
        `SELECT u.id, u.name, u.username, m.role, m.created_at AS "createdAt"
       FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = $1 AND m.deleted_at IS NULL
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at, u.id`,
        [id],
      );
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async searchUsers(
    userId: string,
    id: string,
    query: string,
  ): Promise<ProjectUser[]> {
    const { role } = await this.assertMember(userId, id);
    requireProjectManager(role);
    if (query.trim().length < 2) return [];
    return this.database.query(
      `SELECT u.id, u.name, u.username FROM users u
       WHERE COALESCE(u.banned, false) = false
         AND (strpos(lower(u.name), lower($2)) > 0 OR strpos(lower(COALESCE(u.username, '')), lower($2)) > 0)
         AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = $1 AND m.user_id = u.id AND m.deleted_at IS NULL)
       ORDER BY u.name, u.id LIMIT 20`,
      [id, query.trim()],
    );
  }

  addMember(
    userId: string,
    id: string,
    input: { userId: string; role: 'admin' | 'member' },
  ) {
    return this.mutate(userId, id, async (manager, _project, role) => {
      requireMemberChange(role, 'member', input.role);
      const users: ProjectUser[] = await manager.query(
        'SELECT id, name, username FROM users WHERE id = $1 AND COALESCE(banned, false) = false',
        [input.userId],
      );
      if (!users.length) throw new ThreadError('PROJECT_USER_NOT_FOUND', 404);
      const previous = await manager.findOne(ProjectMember, {
        where: { projectId: id, userId: input.userId },
        withDeleted: true,
      });
      if (previous && !previous.deletedAt)
        throw new ThreadError('PROJECT_MEMBER_EXISTS', 409);
      await manager.save(
        ProjectMember,
        manager.create(ProjectMember, {
          projectId: id,
          userId: input.userId,
          role: input.role,
          deletedAt: null,
        }),
      );
      const member = await manager.findOneByOrFail(ProjectMember, {
        projectId: id,
        userId: input.userId,
      });
      return {
        ...users[0],
        role: member.role,
        createdAt: member.createdAt.toISOString(),
      };
    });
  }

  changeMember(
    userId: string,
    id: string,
    targetId: string,
    nextRole?: 'admin' | 'member',
  ) {
    return this.mutate(userId, id, async (manager, _project, role) => {
      const target = await manager.findOneBy(ProjectMember, {
        projectId: id,
        userId: targetId,
      });
      if (!target) throw new ThreadError('PROJECT_USER_NOT_FOUND', 404);
      requireMemberChange(role, target.role, nextRole);
      if (nextRole) {
        target.role = nextRole;
        await manager.save(target);
      } else await manager.softRemove(target);
    });
  }
}
