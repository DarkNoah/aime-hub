import type { ChatSettings } from '@aime/shared/threads';
import type {
  ProjectCreateInput,
  ProjectListStatus,
} from '@aime/shared/projects';
import { api } from '../../lib/rpc.js';

export const projectApi = {
  list: (
    page = 0,
    signal?: AbortSignal,
    perPage = 20,
    status: ProjectListStatus = 'active',
  ) => api.projects.list({ query: { page, perPage, status } }, { signal }),
  get: (projectId: string, signal?: AbortSignal) =>
    api.projects.get({ params: { projectId } }, { signal }),
  create: (input: ProjectCreateInput) => api.projects.create({ body: input }),
  update: (projectId: string, name: string) =>
    api.projects.update({ params: { projectId }, body: { name } }),
  setArchived: (projectId: string, archived: boolean) =>
    api.projects.update({ params: { projectId }, body: { archived } }),
  pin: (projectId: string, pinned: boolean) =>
    api.projects.pin({ params: { projectId }, body: { pinned } }),
  remove: (projectId: string) => api.projects.remove({ params: { projectId } }),
  members: (projectId: string, signal?: AbortSignal) =>
    api.projects.members({ params: { projectId } }, { signal }),
  searchUsers: (projectId: string, query: string, signal?: AbortSignal) =>
    api.projects.searchUsers(
      { params: { projectId }, query: { q: query } },
      { signal },
    ),
  addMember: (projectId: string, userId: string, role: 'admin' | 'member') =>
    api.projects.addMember({ params: { projectId }, body: { userId, role } }),
  changeRole: (projectId: string, userId: string, role: 'admin' | 'member') =>
    api.projects.changeRole({ params: { projectId, userId }, body: { role } }),
  removeMember: (projectId: string, userId: string) =>
    api.projects.removeMember({ params: { projectId, userId } }),
  savePreferences: (projectId: string, settings: ChatSettings) =>
    api.projects.savePreferences({ params: { projectId }, body: settings }),
};
