import { z } from 'zod';
import { type } from '@orpc/contract';
import { procedure, threadId } from './base.js';
import {
  browserActionSchema,
  type BrowserState,
  type BrowserSummary,
} from '../browser.js';

export const browserContract = {
  list: procedure
    .route({
      method: 'GET',
      path: '/threads/browsers',
      inputStructure: 'detailed',
    })
    .output(type<BrowserSummary[]>()),
  state: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/browser',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<BrowserState>()),
  action: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/browser',
      inputStructure: 'detailed',
    })
    .input(
      z.object({ params: z.object({ threadId }), body: browserActionSchema }),
    )
    .output(type<void>()),
};
