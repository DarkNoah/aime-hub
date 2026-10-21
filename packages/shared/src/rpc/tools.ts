import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure } from './base.js';
import {
  webSearchConfigSchema,
  webFetchConfigSchema,
  imageGenConfigSchema,
  speechConfigSchema,
  transcriptionsConfigSchema,
  readFileConfigSchema,
  extractConfigSchema,
  enabledToolConfigSchema,
  toolIdSchema,
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
          params: z.object({ toolId: z.literal('extract') }),
          body: extractConfigSchema,
        }),
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
        z.object({
          params: z.object({ toolId: z.literal('speech') }),
          body: speechConfigSchema,
        }),
        z.object({
          params: z.object({ toolId: z.literal('transcriptions') }),
          body: transcriptionsConfigSchema,
        }),
        z.object({
          params: z.object({ toolId: z.literal('read_file') }),
          body: readFileConfigSchema,
        }),
        z.object({
          params: z.object({ toolId: toolIdSchema }),
          body: enabledToolConfigSchema,
        }),
      ]),
    )
    .output(type<ToolConfig>()),
  setEnabled: procedure
    .route({
      method: 'PATCH',
      path: '/admin/tools/{toolId}/enabled',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ toolId: toolIdSchema }),
        body: z.strictObject({ enabled: z.boolean() }),
      }),
    )
    .output(type<ToolConfig>()),
};
