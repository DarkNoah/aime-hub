import { type } from '@orpc/contract';
import { z } from 'zod';
import { assetQuerySchema, type AssetList } from '../assets.js';
import { MAX_CHAT_FILES, type RunInput } from '../threads.js';
import { procedure, threadId } from './base.js';

export const assetsContract = {
  list: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/assets',
      inputStructure: 'detailed',
    })
    .input(
      z.object({ params: z.object({ threadId }), query: assetQuerySchema }),
    )
    .output(type<AssetList>()),
  attach: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/assets/attach',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ threadId }),
        body: z.object({ ids: z.array(z.uuid()).min(1).max(MAX_CHAT_FILES) }),
      }),
    )
    .output(type<{ parts: RunInput['parts'] }>()),
};
