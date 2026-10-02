import type {
  ProjectDetail,
  ProjectList,
  ProjectMember,
  ProjectSummary,
  ProjectUser,
} from '@aime/shared/projects';
import type { ChatSettings } from '@aime/shared/threads';
import { chatRequest } from '../../components/chat/api.js';

const request = <T>(path: string, init?: RequestInit) =>
  chatRequest<T>(path, init, '/api/projects');
const body = (method: string, input: unknown) => ({
  method,
  body: JSON.stringify(input),
});
export const projectApi = {
  list: (page = 0, signal?: AbortSignal, perPage = 20) =>
    request<ProjectList>(`?page=${page}&perPage=${perPage}`, { signal }),
  get: (id: string, signal?: AbortSignal) =>
    request<ProjectDetail>(`/${id}`, { signal }),
  create: (name: string) => request<ProjectDetail>('', body('POST', { name })),
  update: (id: string, name: string) =>
    request<ProjectSummary>(`/${id}`, body('PATCH', { name })),
  remove: (id: string) => request<void>(`/${id}`, { method: 'DELETE' }),
  members: (id: string, signal?: AbortSignal) =>
    request<ProjectMember[]>(`/${id}/members`, { signal }),
  searchUsers: (id: string, query: string, signal?: AbortSignal) =>
    request<ProjectUser[]>(`/${id}/users?q=${encodeURIComponent(query)}`, {
      signal,
    }),
  addMember: (id: string, userId: string, role: 'admin' | 'member') =>
    request<ProjectMember>(`/${id}/members`, body('POST', { userId, role })),
  changeRole: (id: string, userId: string, role: 'admin' | 'member') =>
    request<void>(
      `/${id}/members/${encodeURIComponent(userId)}`,
      body('PATCH', { role }),
    ),
  removeMember: (id: string, userId: string) =>
    request<void>(`/${id}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    }),
  savePreferences: (id: string, settings: ChatSettings) =>
    request<ChatSettings>(`/${id}/preferences`, body('PUT', settings)),
};
