import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  localAgentScopeSchema,
  localAgentDocumentSchema,
  type LocalAgentList,
  type LocalAgentFile,
  type LocalAgentCreateResult,
} from '../agents.js';

const fileInput = z.object({
  target: localAgentScopeSchema,
  filename: z.string().regex(/^[a-zA-Z0-9_:-]{1,58}\.md$/),
  version: z.string(),
});

export const localAgentsContract = {
  list: procedure
    .route({ method: 'GET', path: '/local-agents', inputStructure: 'detailed' })
    .input(z.object({ query: localAgentScopeSchema }))
    .output(type<LocalAgentList>()),
  create: procedure
    .route({
      method: 'POST',
      path: '/local-agents',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        body: localAgentDocumentSchema.extend({
          target: localAgentScopeSchema,
        }),
      }),
    )
    .output(type<LocalAgentCreateResult>()),
  update: procedure
    .route({ method: 'PUT', path: '/local-agents', inputStructure: 'detailed' })
    .input(z.object({ body: fileInput.extend(localAgentDocumentSchema.shape) }))
    .output(type<LocalAgentCreateResult>()),
  remove: procedure
    .route({
      method: 'DELETE',
      path: '/local-agents',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ body: fileInput }))
    .output(type<void>()),
  setEnabled: procedure
    .route({
      method: 'PATCH',
      path: '/local-agents/enabled',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        body: fileInput.extend({
          enabled: z.boolean(),
        }),
      }),
    )
    .output(type<LocalAgentFile>()),
};
