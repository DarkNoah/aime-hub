import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, id } from './base.js';
import {
  mcpCreateSchema,
  mcpUpdateSchema,
  mcpStatusSchema,
  type McpServer,
  type McpToolDefinition,
  type McpAuthorization,
} from '../mcp.js';

const params = z.object({ id });
export const mcpContract = {
  authorize: procedure
    .route({
      method: 'POST',
      path: '/admin/mcp/{id}/oauth/authorize',
      inputStructure: 'detailed',
    })
    .input(
      z.object({ params, body: z.object({ revision: z.string().uuid() }) }),
    )
    .output(type<{ authorizationUrl: string }>()),
  disconnectOAuth: procedure
    .route({
      method: 'POST',
      path: '/admin/mcp/{id}/oauth/disconnect',
      inputStructure: 'detailed',
    })
    .input(
      z.object({ params, body: z.object({ revision: z.string().uuid() }) }),
    )
    .output(type<McpServer>()),
  load: procedure
    .route({
      method: 'POST',
      path: '/admin/mcp/{id}/load',
      inputStructure: 'detailed',
    })
    .input(z.object({ params }))
    .output(type<McpServer>()),
  tools: procedure
    .route({
      method: 'GET',
      path: '/admin/mcp/{id}/tools',
      inputStructure: 'detailed',
    })
    .input(z.object({ params }))
    .output(type<McpToolDefinition[]>()),
  test: procedure
    .route({
      method: 'POST',
      path: '/admin/mcp/{id}/test',
      inputStructure: 'detailed',
    })
    .input(z.object({ params }))
    .output(type<{ toolCount: number }>()),
  list: procedure
    .route({ method: 'GET', path: '/admin/mcp', inputStructure: 'detailed' })
    .output(type<McpServer[]>()),
  get: procedure
    .route({
      method: 'GET',
      path: '/admin/mcp/{id}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params }))
    .output(type<McpServer>()),
  create: procedure
    .route({
      method: 'POST',
      path: '/admin/mcp',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ body: mcpCreateSchema }))
    .output(type<McpServer[]>()),
  update: procedure
    .route({
      method: 'PUT',
      path: '/admin/mcp/{id}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params, body: mcpUpdateSchema }))
    .output(type<McpServer>()),
  status: procedure
    .route({
      method: 'PATCH',
      path: '/admin/mcp/{id}/status',
      inputStructure: 'detailed',
    })
    .input(z.object({ params, body: mcpStatusSchema }))
    .output(type<McpServer>()),
  remove: procedure
    .route({
      method: 'DELETE',
      path: '/admin/mcp/{id}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(
      z.object({ params, query: z.object({ revision: z.string().uuid() }) }),
    )
    .output(type<void>()),
};

export const mcpAuthContract = {
  list: procedure
    .route({
      method: 'GET',
      path: '/mcp/authorizations',
      inputStructure: 'detailed',
    })
    .output(type<McpAuthorization[]>()),
  get: procedure
    .route({
      method: 'GET',
      path: '/mcp/authorizations/{id}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params }))
    .output(type<McpAuthorization>()),
  authorize: procedure
    .route({
      method: 'POST',
      path: '/mcp/authorizations/{id}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params, body: z.object({ returnTo: z.string() }) }))
    .output(type<{ authorizationUrl: string }>()),
};
