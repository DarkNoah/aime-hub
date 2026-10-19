import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, threadId } from './base.js';
import {
  fileMutationSchema,
  fileSaveSchema,
  fileScopeSchema,
  type FileListing,
  type FilePreview,
  type FileSearch,
  type WorkspaceFileReference,
} from '../files.js';

export const filesContract = {
  save: procedure
    .route({
      method: 'PUT',
      path: '/threads/{threadId}/files/content',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ threadId }),
        query: z.object({ scope: fileScopeSchema.default('thread') }),
        body: fileSaveSchema,
      }),
    )
    .output(type<FilePreview>()),
  resolve: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/files/resolve',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ threadId }),
        query: z.object({ path: z.string().min(1).max(2048) }),
      }),
    )
    .output(type<WorkspaceFileReference>()),
  list: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/files',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ threadId }),
        query: z.object({
          path: z.string().max(2048).default(''),
          scope: fileScopeSchema.default('thread'),
        }),
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
        query: z.object({
          path: z.string().max(2048).default(''),
          scope: fileScopeSchema.default('thread'),
        }),
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
        query: z.object({
          query: z.string().trim().min(1).max(200),
          scope: fileScopeSchema.default('thread'),
        }),
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
      z.object({
        params: z.object({ threadId }),
        body: fileMutationSchema,
        query: z
          .object({ scope: fileScopeSchema.default('thread') })
          .optional(),
      }),
    )
    .output(type<{ path: string }>()),
};
