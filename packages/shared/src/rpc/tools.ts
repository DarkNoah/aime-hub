import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  webSearchConfigSchema,
  webFetchConfigSchema,
  imageGenConfigSchema,
  type ToolConfig,
} from '../tools.js';

export const toolsContract = {
  list: procedure
    .route({ method: 'GET', path: '/admin/tools', inputStructure: 'detailed' })
    .output(type<ToolConfig[]>()),
  update: procedure
    .route({
      method: 'PUT',
      path: '/admin/tools/{toolId}',
      inputStructure: 'detailed',
    })
    .input(
      z.union([
        z.object({
          params: z.object({ toolId: z.literal('web_search') }),
          body: webSearchConfigSchema,
        }),
        z.object({
          params: z.object({ toolId: z.literal('web_fetch') }),
          body: webFetchConfigSchema,
        }),
        z.object({
          params: z.object({ toolId: z.literal('image_gen') }),
          body: imageGenConfigSchema,
        }),
      ]),
    )
    .output(type<ToolConfig>()),
};
