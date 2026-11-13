import { rpc, required } from '../../rpc/context.js';
import type { SkillService } from './service.js';
import { listFiles, previewFile } from '../files/service.js';
import { saveWorkspaceFile } from '../files/save.js';

export function skillRouter(service?: SkillService) {
  return createSkillRouter(rpc.skills, () => required(service));
}

export function personalSkillRouter(service?: SkillService) {
  return createSkillRouter(rpc.personalSkills, (userId) =>
    required(service).forUser(userId),
  );
}

function createSkillRouter(
  p: typeof rpc.skills,
  skills: (userId: string) => SkillService,
) {
  return p.router({
    files: {
      list: p.files.list.handler(({ context, input }) =>
        skills(context.userId).withFiles(input.query.skill, (root) =>
          listFiles(root, input.query.path),
        ),
      ),
      preview: p.files.preview.handler(({ context, input }) =>
        skills(context.userId).withFiles(input.query.skill, (root) =>
          previewFile(root, input.query.path),
        ),
      ),
      save: p.files.save.handler(({ context, input }) => {
        const service = skills(context.userId);
        return service.withFiles(input.query.skill, async (root) => {
          const file = await saveWorkspaceFile(root, input.body);
          const skill = (await service.list()).skills.find(
            (skill) => skill.path === input.query.skill,
          )!;
          return { file, skill };
        });
      }),
    },
    list: p.list.handler(({ context }) => skills(context.userId).list()),
    read: p.read.handler(({ context, input }) =>
      skills(context.userId).read(input.query.path),
    ),
    updateGroup: p.updateGroup.handler(({ context, input }) =>
      skills(context.userId).updateGroup(input.body.group, input.body.source),
    ),
    scan: p.scan.handler(({ context, input, signal }) =>
      skills(context.userId).scan(input.body.url, signal),
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
  });
}
