import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, threadId } from './base.js';
import {
  fileMutationSchema,
  type FileListing,
  type FilePreview,
  type FileSearch,
} from '../files.js';

export const filesContract = {
  list: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/files',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ threadId }),
        query: z.object({ path: z.string().max(2048).default('') }),
      }),
    )
    .output(type<FileListing>()),
  preview: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/files/preview',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ threadId }),
        query: z.object({ path: z.string().max(2048).default('') }),
      }),
    )
    .output(type<FilePreview>()),
  search: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/files/search',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ threadId }),
        query: z.object({ query: z.string().trim().min(1).max(200) }),
      }),
    )
    .output(type<FileSearch>()),
  mutate: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/files',
      inputStructure: 'detailed',
    })
    .input(
      z.object({ params: z.object({ threadId }), body: fileMutationSchema }),
    )
    .output(type<{ path: string }>()),
};
