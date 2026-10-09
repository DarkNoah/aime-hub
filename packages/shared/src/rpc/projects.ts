import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, id, threadId, page, perPage } from './base.js';
import {
  projectUpdateSchema,
  projectCreateSchema,
  projectMemberSchema,
  projectMemberRoleSchema,
  projectPreferencesSchema,
  type ProjectList,
  type ProjectDetail,
  type ProjectSummary,
  type ProjectMember,
  type ProjectUser,
} from '../projects.js';
import type { ChatSettings } from '../threads.js';

export const projectsContract = {
  list: procedure
    .route({ method: 'GET', path: '/projects', inputStructure: 'detailed' })
    .input(
      z.object({
        query: z.object({
          page,
          perPage: perPage.default(20),
          status: z.enum(['active', 'archived', 'all']).default('active'),
        }),
      }),
    )
    .output(type<ProjectList>()),
  create: procedure
    .route({
      method: 'POST',
      path: '/projects',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ body: projectCreateSchema }))
    .output(type<ProjectDetail>()),
  get: procedure
    .route({
      method: 'GET',
      path: '/projects/{projectId}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ projectId: threadId }) }))
    .output(type<ProjectDetail>()),
  update: procedure
    .route({
      method: 'PATCH',
      path: '/projects/{projectId}',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ projectId: threadId }),
        body: projectUpdateSchema,
      }),
    )
    .output(type<ProjectSummary>()),
  pin: procedure
    .route({
      method: 'PATCH',
      path: '/projects/{projectId}/pin',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ projectId: threadId }),
        body: z.object({ pinned: z.boolean() }).strict(),
      }),
    )
    .output(type<ProjectSummary>()),
  remove: procedure
    .route({
      method: 'DELETE',
      path: '/projects/{projectId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ projectId: threadId }) }))
    .output(type<void>()),
  preferences: procedure
    .route({
      method: 'GET',
      path: '/projects/{projectId}/preferences',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ projectId: threadId }) }))
    .output(type<ChatSettings>()),
  savePreferences: procedure
    .route({
      method: 'PUT',
      path: '/projects/{projectId}/preferences',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ projectId: threadId }),
        body: projectPreferencesSchema,
      }),
    )
    .output(type<ChatSettings>()),
  members: procedure
    .route({
      method: 'GET',
      path: '/projects/{projectId}/members',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ projectId: threadId }) }))
    .output(type<ProjectMember[]>()),
  searchUsers: procedure
    .route({
      method: 'GET',
      path: '/projects/{projectId}/users',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ projectId: threadId }),
        query: z.object({ q: z.string().trim().max(100).default('') }),
      }),
    )
    .output(type<ProjectUser[]>()),
  addMember: procedure
    .route({
      method: 'POST',
      path: '/projects/{projectId}/members',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(
      z.object({
        params: z.object({ projectId: threadId }),
        body: projectMemberSchema,
      }),
    )
    .output(type<ProjectMember>()),
  changeRole: procedure
    .route({
      method: 'PATCH',
      path: '/projects/{projectId}/members/{userId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(
      z.object({
        params: z.object({ projectId: threadId, userId: id }),
        body: projectMemberRoleSchema,
      }),
    )
    .output(type<void>()),
  removeMember: procedure
    .route({
      method: 'DELETE',
      path: '/projects/{projectId}/members/{userId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ projectId: threadId, userId: id }) }))
    .output(type<void>()),
};
