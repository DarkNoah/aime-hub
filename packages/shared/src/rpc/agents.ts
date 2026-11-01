import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  agentInputSchema,
  agentUpdateSchema,
  agentStatusSchema,
  agentIdSchema,
  agentDefaultsSchema,
  type AgentDefaults,
  type AvailableAgents,
  type AdminAgent,
  type AgentCatalog,
  type ManagedAgent,
} from '../agents.js';

const path = '/admin/agents';
const params = z.object({ id: agentIdSchema });
export const agentsContract = {
  available: procedure
    .meta({ localApi: true })
    .route({
      method: 'GET',
      path: '/agents/available',
      inputStructure: 'detailed',
      summary: '列出当前用户可用的 Agent 和默认 Agent',
      description:
        '返回可见的代码及插件 Agent、已发布的数据库 Agent，默认包含全局和当前个人范围的本地 Agent；传 projectId 时改为全局和该项目范围，并校验项目成员权限。includeLocal=false 可排除本地 Agent。',
    })
    .input(
      z
        .object({
          query: z
            .object({
              projectId: z
                .string()
                .regex(/^[a-zA-Z0-9_-]{16}$/)
                .optional(),
              includeLocal: z
                .union([
                  z.boolean(),
                  z
                    .enum(['true', 'false'])
                    .transform((value) => value === 'true'),
                ])
                .optional(),
            })
            .optional(),
        })
        .optional(),
    )
    .output(type<AvailableAgents>()),
  defaults: procedure
    .route({
      method: 'GET',
      path: `${path}/defaults`,
      inputStructure: 'detailed',
    })
    .output(type<AgentDefaults>()),
  saveDefaults: procedure
    .route({
      method: 'PUT',
      path: `${path}/defaults`,
      inputStructure: 'detailed',
    })
    .input(z.object({ body: agentDefaultsSchema }))
    .output(type<AgentDefaults>()),
  list: procedure
    .route({ method: 'GET', path, inputStructure: 'detailed' })
    .output(type<AdminAgent[]>()),
  catalog: procedure
    .route({
      method: 'GET',
      path: `${path}/catalog`,
      inputStructure: 'detailed',
    })
    .output(type<AgentCatalog>()),
  get: procedure
    .route({ method: 'GET', path: `${path}/{id}`, inputStructure: 'detailed' })
    .input(z.object({ params }))
    .output(type<AdminAgent>()),
  create: procedure
    .route({
      method: 'POST',
      path,
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ body: agentInputSchema }))
    .output(type<ManagedAgent>()),
  update: procedure
    .route({ method: 'PUT', path: `${path}/{id}`, inputStructure: 'detailed' })
    .input(z.object({ params, body: agentUpdateSchema }))
    .output(type<ManagedAgent>()),
  setStatus: procedure
    .route({
      method: 'PATCH',
      path: `${path}/{id}/status`,
      inputStructure: 'detailed',
    })
    .input(z.object({ params, body: agentStatusSchema }))
    .output(type<ManagedAgent>()),
  remove: procedure
    .route({
      method: 'DELETE',
      path: `${path}/{id}`,
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(
      z.object({ params, query: z.object({ versionId: z.string().uuid() }) }),
    )
    .output(type<void>()),
};
