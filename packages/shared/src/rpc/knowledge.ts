import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, id } from './base.js';
import {
  knowledgeScopeSchema,
  knowledgeTagsSchema,
  knowledgeMetadataSchema,
  knowledgeVersionInputSchema,
  type KnowledgeTags,
  type KnowledgeVersion,
  type KnowledgeVersionDetail,
  knowledgeSharingSchema,
  knowledgeDocumentUpdateSchema,
  type KnowledgeSharingDetail,
  knowledgeMemberInputSchema,
  knowledgeMemberPageSchema,
  type KnowledgeMember,
  type KnowledgeMemberPage,
  type KnowledgeUserPage,
  knowledgeCursorSchema,
  type KnowledgeCursor,
  knowledgeBaseInputSchema,
  knowledgeBaseUpdateSchema,
  knowledgeSourceSchema,
  knowledgeSearchSchema,
  type KnowledgeBase,
  type KnowledgeDocument,
  type KnowledgeDocumentDetail,
  type KnowledgeHit,
} from '../knowledge.js';
const target = z.object({ id });
export const knowledgeContract = {
  modelDefaults:
    procedure.output(
      type<{ embeddingModel: string | null; rerankModel: string | null }>(),
    ),
  get: procedure.input(target).output(type<KnowledgeBase>()),
  sharing: procedure.input(target).output(type<KnowledgeSharingDetail>()),
  setSharing: procedure
    .input(target.extend({ sharing: knowledgeSharingSchema }))
    .output(type<KnowledgeBase>()),
  members: procedure
    .input(target.extend(knowledgeMemberPageSchema.shape))
    .output(type<KnowledgeMemberPage>()),
  setMember: procedure
    .input(target.extend({ member: knowledgeMemberInputSchema }))
    .output(type<KnowledgeMember>()),
  removeMember: procedure
    .input(target.extend({ userId: z.string().min(1).max(128) }))
    .output(type<void>()),
  searchUsers: procedure
    .input(
      target.extend({
        query: z.string().trim().min(2).max(100),
        cursor: z.string().min(1).max(128).optional(),
      }),
    )
    .output(type<KnowledgeUserPage>()),
  createVersion: procedure
    .input(target.extend({ data: knowledgeVersionInputSchema }))
    .output(type<KnowledgeDocument>()),
  versions: procedure
    .input(target.extend({ before: z.number().int().positive().optional() }))
    .output(type<{ versions: KnowledgeVersion[]; nextBefore?: number }>()),
  version: procedure
    .input(target.extend({ version: z.number().int().positive() }))
    .output(type<KnowledgeVersionDetail>()),
  versionFile: procedure
    .input(target.extend({ version: z.number().int().positive() }))
    .output(type<{ name: string; data: string }>()),
  tags: procedure.input(target).output(type<KnowledgeTags>()),
  updateDocument: procedure
    .input(target.extend({ data: knowledgeDocumentUpdateSchema }))
    .output(type<KnowledgeDocument>()),
  list: procedure
    .input(knowledgeScopeSchema)
    .output(type<{ bases: KnowledgeBase[]; canManage: boolean }>()),
  create: procedure
    .input(
      z.object({ scope: knowledgeScopeSchema, data: knowledgeBaseInputSchema }),
    )
    .output(type<KnowledgeBase>()),
  update: procedure
    .input(target.extend({ data: knowledgeBaseUpdateSchema }))
    .output(type<KnowledgeBase>()),
  remove: procedure.input(target).output(type<void>()),
  documents: procedure
    .input(
      target.extend({
        cursor: knowledgeCursorSchema.optional(),
        tags: knowledgeTagsSchema.optional(),
        metadata: knowledgeMetadataSchema.optional(),
        archived: z.boolean().default(false),
      }),
    )
    .output(
      type<{
        documents: KnowledgeDocument[];
        hasMore: boolean;
        nextCursor?: KnowledgeCursor;
      }>(),
    ),
  statuses: procedure
    .input(target.extend({ ids: z.array(id).max(100) }))
    .output(type<KnowledgeDocument[]>()),
  import: procedure
    .input(
      target.extend({
        source: knowledgeSourceSchema,
        tags: knowledgeTagsSchema.optional(),
        metadata: knowledgeMetadataSchema.optional(),
      }),
    )
    .output(type<KnowledgeDocument>()),
  document: procedure.input(target).output(type<KnowledgeDocumentDetail>()),
  retry: procedure.input(target).output(type<KnowledgeDocument>()),
  setDocumentEnabled: procedure
    .input(target.extend({ enabled: z.boolean() }))
    .output(type<KnowledgeDocument>()),
  restoreDocument: procedure.input(target).output(type<KnowledgeDocument>()),
  removeDocument: procedure.input(target).output(type<void>()),
  search: procedure
    .input(target.extend(knowledgeSearchSchema.shape))
    .output(type<KnowledgeHit[]>()),
};
