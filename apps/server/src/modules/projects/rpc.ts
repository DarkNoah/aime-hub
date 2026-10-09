import { rpc, required } from '../../rpc/context.js';
import type { ProjectService } from './service.js';
import type { ThreadService } from '../threads/service.js';
import type { LanguageModelService } from '../models/language-model.js';
import { ThreadError } from '../threads/errors.js';
import { requireProjectManager } from './permissions.js';

export function projectRouter(
  service?: ProjectService,
  threadService?: ThreadService,
  models?: LanguageModelService,
) {
  const p = rpc.projects;
  const projects = () => required(service);
  const threads = () => required(threadService);
  return p.router({
    list: p.list.handler(({ context, input }) =>
      projects().list(
        context.userId,
        input.query.page,
        input.query.perPage,
        input.query.status,
      ),
    ),
    get: p.get.handler(({ context, input }) =>
      projects().get(context.userId, input.params.projectId),
    ),
    create: p.create.handler(async ({ context, input }) => {
      const project = await projects().create(context.userId, input.body);
      threads().refreshNavigation(context.userId);
      return project;
    }),
    update: p.update.handler(async ({ context, input }) => {
      const project = await projects().update(
        context.userId,
        input.params.projectId,
        input.body,
      );
      threads().refreshNavigation();
      return project;
    }),
    pin: p.pin.handler(async ({ context, input }) => {
      const project = await projects().pin(
        context.userId,
        input.params.projectId,
        input.body.pinned,
      );
      threads().refreshNavigation(context.userId);
      return project;
    }),
    remove: p.remove.handler(async ({ context, input }) => {
      const id = input.params.projectId;
      const { role } = await projects().assertMember(context.userId, id);
      if (role !== 'owner') throw new ThreadError('FORBIDDEN', 403);
      await threads().withProjectDeletion(id, () =>
        projects().remove(context.userId, id),
      );
    }),
    preferences: p.preferences.handler(({ context, input }) =>
      projects().preferences(context.userId, input.params.projectId),
    ),
    savePreferences: p.savePreferences.handler(async ({ context, input }) => {
      const id = input.params.projectId;
      requireProjectManager(
        (await projects().assertMember(context.userId, id)).role,
      );
      if (input.body.model)
        await required(models).getLanguageModel(context.userId, input.body, id);
      return projects().savePreferences(context.userId, id, input.body);
    }),
    members: p.members.handler(({ context, input }) =>
      projects().members(context.userId, input.params.projectId),
    ),
    searchUsers: p.searchUsers.handler(({ context, input }) =>
      projects().searchUsers(
        context.userId,
        input.params.projectId,
        input.query.q,
      ),
    ),
    addMember: p.addMember.handler(async ({ context, input }) => {
      const member = await projects().addMember(
        context.userId,
        input.params.projectId,
        input.body,
      );
      threads().refreshNavigation(member.id);
      return member;
    }),
    changeRole: p.changeRole.handler(async ({ context, input }) => {
      await projects().changeMember(
        context.userId,
        input.params.projectId,
        input.params.userId,
        input.body.role,
      );
      threads().refreshNavigation(input.params.userId);
    }),
    removeMember: p.removeMember.handler(async ({ context, input }) => {
      await projects().changeMember(
        context.userId,
        input.params.projectId,
        input.params.userId,
      );
      threads().invalidateProject(input.params.projectId, input.params.userId);
    }),
  });
}
