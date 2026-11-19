import type { Project } from '@aime/db';
import type { apiContract } from '@aime/shared/rpc';
import {
  defaultProjectWorkspace,
  projectWorkspaceSchema,
} from '@aime/shared/projects';
import { rpc, required } from '../../rpc/context.js';
import type { SkillService } from './service.js';
import { previewFile } from '../files/service.js';
import { assertSkillFilePath, listSkillFiles } from './files.js';
import { saveWorkspaceFile } from '../files/save.js';
import type { ProjectService } from '../projects/service.js';
import type {
  InstalledSkill,
  SkillDestination,
  SkillSharing,
} from '@aime/shared/skills';
import type { UserService } from '../users/service.js';
import { SkillOrigins } from './origins.js';
import { SkillError } from './errors.js';

export function skillRouter(service?: SkillService, users?: UserService) {
  const origins = service && new SkillOrigins(service.root);
  return rpc.skills.router(
    skillHandlers(rpc.skills, () => required(service), origins, users),
  );
}

export function personalSkillRouter(
  service?: SkillService,
  projects?: ProjectService,
) {
  const p = rpc.personalSkills;
  const origins = service && new SkillOrigins(service.root);
  function withWorkspace<T>(
    project: Project | undefined,
    action: (skills: SkillService) => Promise<T>,
  ) {
    const skills = required(service);
    return project
      ? skills.withProjectWorkspace(
          project.id,
          projectWorkspaceSchema.parse(
            project.metadata?.workspace ?? defaultProjectWorkspace,
          ),
          action,
        )
      : action(skills);
  }
  return p.router({
    ...skillHandlers(p, (userId) => required(service).forUser(userId)),
    sharing: p.sharing.handler(async ({ context }) => {
      const skills = required(service);
      const managed =
        (await projects?.listManagedSkillProjects(context.userId)) ?? [];
      const locations: { target: SkillDestination; name?: string }[] =
        managed.map((project) => ({
          target: { scope: 'project', projectId: project.id },
          name: project.name,
        }));
      if (context.isAdmin) locations.push({ target: { scope: 'global' } });
      const [links, legacy] = await Promise.all([
        Promise.all(
          locations.map(async ({ target, name }) => {
            const entries = await skills.listPersonalShares(
              context.userId,
              target,
            );
            const sharing = {
              ...target,
              userId: context.userId,
              userName: context.userName,
              ...(name && { projectName: name }),
            };
            return entries.map((skill) => ({ ...skill, sharing }));
          }),
        ),
        required(origins).sharedBy(
          context.userId,
          context.isAdmin,
          managed,
          (target) =>
            target.scope === 'global'
              ? skills.list()
              : required(projects).withManagementAccess(
                  context.userId,
                  target.projectId,
                  (_manager, project) =>
                    withWorkspace(project, (scoped) => scoped.list()),
                ),
        ),
      ]);
      return {
        global: context.isAdmin,
        projects: managed
          .filter((project) => !project.archived)
          .map(({ id, name }) => ({ id, name })),
        shared: [...links.flat(), ...legacy],
      };
    }),
    setSharing: p.setSharing.handler(({ context, input }) => {
      const { path, target } = input.body;
      const destination = target.scope === 'personal' ? target.from : target;
      const setSharing = async (project?: Project) => {
        const skills = required(service);
        const sharing: SkillSharing = {
          ...destination,
          userId: context.userId,
          userName: context.userName,
          ...(project && { projectName: project.name }),
        };
        if (target.scope === 'personal') {
          try {
            return await skills.unsharePersonal(
              context.userId,
              path,
              destination,
            );
          } catch (error) {
            if (!(
              error instanceof SkillError && error.code === 'SKILL_NOT_FOUND'
            ))
              throw error;
            return withWorkspace(project, () =>
              required(origins).restore(skills, path, sharing),
            );
          }
        }
        if (project?.archived) throw new SkillError('PROJECT_ARCHIVED', 409);
        const entries = await withWorkspace(project, () =>
          skills.sharePersonal(context.userId, path, destination),
        );
        return entries.map((skill) => ({ ...skill, sharing }));
      };
      if (destination.scope === 'project')
        return required(projects).withManagementAccess(
          context.userId,
          destination.projectId,
          (_manager, project) => setSharing(project),
        );
      if (!context.isAdmin) throw new SkillError('FORBIDDEN', 403);
      return setSharing();
    }),
  });
}

function skillHandlers(
  p: Pick<typeof rpc.skills, keyof typeof apiContract.skills>,
  skills: (userId: string) => SkillService,
  origins?: SkillOrigins,
  users?: UserService,
) {
  const annotate = async (root: string, items: InstalledSkill[]) => {
    if (!origins) return items;
    const ids = [
      ...new Set(
        items.flatMap((item) => (item.sharing ? [item.sharing.userId] : [])),
      ),
    ];
    const names = ids.length
      ? await users?.skillPublisherNames(ids)
      : undefined;
    const annotated = await origins.annotateGlobal(root, items);
    return annotated.map((skill) => {
      const sharing = skill.sharing;
      const name =
        sharing && !sharing.legacyMoved && names?.get(sharing.userId);
      return name
        ? { ...skill, sharing: { ...sharing, userName: name } }
        : skill;
    });
  };
  return {
    files: {
      list: p.files.list.handler(({ context, input }) =>
        skills(context.userId).withFiles(input.query.skill, (root, skill) =>
          listSkillFiles(root, skill, input.query.path),
        ),
      ),
      preview: p.files.preview.handler(({ context, input }) =>
        skills(context.userId).withFiles(input.query.skill, (root, skill) => {
          assertSkillFilePath(skill, input.query.path);
          return previewFile(root, input.query.path);
        }),
      ),
      save: p.files.save.handler(({ context, input }) => {
        const service = skills(context.userId);
        return service.withFiles(
          input.query.skill,
          async (root, installed) => {
            assertSkillFilePath(installed, input.body.path);
            const file = await saveWorkspaceFile(root, input.body);
            const skill = (await service.list()).skills.find(
              (skill) => skill.path === input.query.skill,
            )!;
            return { file, skill: (await annotate(service.root, [skill]))[0] };
          },
          'write',
        );
      }),
    },
    list: p.list.handler(async ({ context }) => {
      const catalog = await skills(context.userId).list();
      return {
        ...catalog,
        skills: await annotate(catalog.root, catalog.skills),
      };
    }),
    read: p.read.handler(async ({ context, input }) => {
      const service = skills(context.userId);
      const result = await service.read(input.query.path);
      return {
        ...result,
        skill: (await annotate(service.root, [result.skill]))[0],
      };
    }),
    updateGroup: p.updateGroup.handler(async ({ context, input }) => {
      const service = skills(context.userId);
      const result = await service.updateGroup(
        input.body.group,
        input.body.source,
        origins?.replacedGlobalGroup.bind(origins),
      );
      return annotate(service.root, result);
    }),
    scan: p.scan.handler(({ context, input, signal }) =>
      skills(context.userId).scan(input.body.url, signal, input.body.mode),
    ),
    discard: p.discard.handler(({ context, input }) =>
      skills(context.userId).discard(input.params.id),
    ),
    install: p.install.handler(({ context, input }) =>
      skills(context.userId).install(input.body.scanId, input.body.paths),
    ),
    remove: p.remove.handler(({ context, input }) =>
      skills(context.userId).remove(input.body.path),
    ),
    removeGroup: p.removeGroup.handler(({ context, input }) =>
      skills(context.userId).removeGroup(input.body.group, input.body.paths),
    ),
  };
}
