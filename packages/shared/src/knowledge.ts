import { z } from 'zod';

export const knowledgeScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('shared') }),
  z.object({ scope: z.literal('personal') }),
  z.object({
    scope: z.literal('project'),
    projectId: z.string().min(1).max(128),
  }),
]);
export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;
export const knowledgePermissionSchema = z.enum(['read', 'edit']);
export const knowledgeSharingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('private') }),
  z.object({ mode: z.literal('all'), permission: knowledgePermissionSchema }),
  z.object({ mode: z.literal('members') }),
]);
export type KnowledgeSharing = z.infer<typeof knowledgeSharingSchema>;
export type KnowledgeUser = {
  id: string;
  name: string;
  username: string | null;
};
export type KnowledgeSharingDetail = {
  mode: KnowledgeSharing['mode'];
  permission: 'read' | 'edit';
  memberCount: number;
};
export const knowledgeMemberInputSchema = z.object({
  userId: z.string().min(1).max(128),
  permission: knowledgePermissionSchema,
});
export type KnowledgeMember = KnowledgeUser & { permission: 'read' | 'edit' };
export const knowledgeMemberPageSchema = z.object({
  cursor: z.string().min(1).max(128).optional(),
  query: z.string().trim().max(100).default(''),
});
export type KnowledgeMemberPage = {
  members: KnowledgeMember[];
  total: number;
  nextCursor?: string;
};
export type KnowledgeUserPage = { users: KnowledgeUser[]; nextCursor?: string };
const reservedColumns = new Set([
  'id',
  'vector_id',
  'embedding',
  'metadata',
  'namespace',
  'document_id',
  'chunk',
  'position',
  'version',
  'created_at',
  'updated_at',
  'deleted_at',
  'document_version',
  'tags',
]);
export const knowledgeFieldSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .refine((name) => !reservedColumns.has(name)),
  label: z.string().trim().max(80).optional(),
  type: z.enum(['text', 'number', 'boolean', 'date', 'json', 'blob']),
});
export type KnowledgeField = z.infer<typeof knowledgeFieldSchema>;
export const knowledgeMetadataSchema = z.record(z.string(), z.json());
export type KnowledgeMetadata = z.infer<typeof knowledgeMetadataSchema>;
export const knowledgeBaseInputSchema = z.object({
  fields: z
    .array(knowledgeFieldSchema)
    .refine(
      (fields) => new Set(fields.map((f) => f.name)).size === fields.length,
    )
    .default([]),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
  embeddingModel: z.string().min(3).max(512).nullable().optional(),
  rerankModel: z.string().min(3).max(512).nullable().optional(),
});
export const knowledgeBaseUpdateSchema = knowledgeBaseInputSchema
  .pick({
    name: true,
    description: true,
    embeddingModel: true,
    rerankModel: true,
  })
  .partial()
  .extend({ enabled: z.boolean().optional() });
export const maxKnowledgeFileBytes = 10 * 1024 * 1024;
export const knowledgeImageFileAccept = '.png,.jpg,.jpeg,.webp,.gif,.bmp';
export const knowledgeFileAccept = `.txt,.md,.markdown,.html,.htm,.json,.csv,.pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.rtf,${knowledgeImageFileAccept}`;
export const knowledgeSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    name: z.string().trim().min(1).max(240),
    content: z.string().trim().min(1).max(1_000_000),
  }),
  z.object({
    type: z.literal('url'),
    name: z.string().trim().max(240).default(''),
    url: z
      .string()
      .url()
      .max(4096)
      .refine((s) => {
        const u = new URL(s);
        return (
          ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
        );
      }),
  }),
  z.object({
    type: z.literal('file'),
    name: z.string().trim().min(1).max(240),
    data: z
      .string()
      .min(1)
      .max(Math.ceil(maxKnowledgeFileBytes / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
]);
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export const knowledgeTagsSchema = z.record(
  z.string().trim().min(1).max(64),
  z
    .array(z.string().trim().min(1).max(128))
    .min(1)
    .transform((values) => [...new Set(values)]),
);
export type KnowledgeTags = z.infer<typeof knowledgeTagsSchema>;
export const knowledgeVersionInputSchema = z.object({
  source: knowledgeSourceSchema,
  tags: knowledgeTagsSchema.optional(),
  metadata: knowledgeMetadataSchema.optional(),
  expectedVersion: z.number().int().positive(),
});
export const knowledgeDocumentUpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(240).optional(),
    source: knowledgeSourceSchema.optional(),
    tags: knowledgeTagsSchema.optional(),
    metadata: knowledgeMetadataSchema.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.source !== undefined ||
      input.tags !== undefined ||
      input.metadata !== undefined,
  );
export type KnowledgeBase = {
  fields: KnowledgeField[];
  vectorIndex: string | null;
  vectorDimension: number | null;
  id: string;
  name: string;
  description: string;
  scope: KnowledgeScope['scope'];
  projectId: string | null;
  embeddingModel: string | null;
  rerankModel: string | null;
  rebuild: KnowledgeRebuild | null;
  enabled: boolean;
  canManage: boolean;
  canEditDocuments: boolean;
  canDelete: boolean;
  canShare: boolean;
  ownerId: string;
  sharingMode: KnowledgeSharing['mode'];
  permission: 'owner' | 'read' | 'edit';
  createdAt: string;
};
export type KnowledgeRebuild = {
  id: string;
  status: 'pending' | 'processing' | 'failed';
  embeddingModel: string | null;
  rerankModel: string | null;
  completed: number;
  total: number;
  error: string | null;
};
export function knowledgeLocked(base: Pick<KnowledgeBase, 'rebuild'>) {
  return (
    base.rebuild?.status === 'pending' || base.rebuild?.status === 'processing'
  );
}
export type KnowledgeDocument = {
  metadata: KnowledgeMetadata;
  createdBy: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  tags: KnowledgeTags;
  id: string;
  baseId: string;
  name: string;
  sourceType: KnowledgeSource['type'];
  sourceUrl: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  enabled: boolean;
  chunkCount: number;
  error: string | null;
  createdAt: string;
};
export type KnowledgeDocumentDetail = KnowledgeDocument & {
  content: string;
  image?: { data: string; mimeType: string };
  chunks: { id: string; text: string; position: number }[];
};
export type KnowledgeVersion = {
  metadata: KnowledgeMetadata;
  version: number;
  name: string;
  sourceType: KnowledgeSource['type'];
  sourceUrl: string | null;
  status: KnowledgeDocument['status'];
  tags: KnowledgeTags;
  createdAt: string;
  createdBy: string;
  isCurrent: boolean;
};
export type KnowledgeVersionDetail = KnowledgeVersion & { content: string };
export const knowledgeSearchSchema = z.object({
  where: z.string().trim().optional(),
  tags: knowledgeTagsSchema.optional(),
  metadata: knowledgeMetadataSchema.optional(),
  query: z.string().trim(),
  topK: z.number().int().min(1).max(100).default(6),
});
export const knowledgeHitSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  baseName: z.string(),
  metadata: knowledgeMetadataSchema.optional(),
  documentId: z.string(),
  name: z.string(),
  text: z.string(),
  inputType: z.literal('image').nullable().optional(),
  sourceUrl: z.string().nullable(),
  // Final sorting score: rerank on success, recall RRF otherwise.
  score: z.number(),
  // Keep keyword for previously stored tool messages.
  mode: z.enum(['vector', 'keyword', 'bm25', 'hybrid']),
  scores: z
    .object({
      // Recall fusion score, retained unchanged after reranking.
      rrf: z.number(),
      vector: z.number().optional(),
      bm25: z.number().optional(),
      rerank: z.number().optional(),
    })
    .optional(),
  fallbacks: z.array(z.enum(['vector', 'rerank'])).optional(),
  fallbackReasons: z
    .object({
      rerank: z
        .enum([
          'timeout',
          'invalid_response',
          'failed',
          'model_conflict',
          'image_unsupported',
        ])
        .optional(),
    })
    .optional(),
});
export type KnowledgeHit = z.infer<typeof knowledgeHitSchema>;

export const knowledgeSearchResultSchema = knowledgeHitSchema
  .omit({ documentId: true, text: true, metadata: true })
  .extend({
    id: knowledgeHitSchema.shape.id.describe('Matched chunk ID.'),
    item_id: z
      .string()
      .describe('Document ID for reading, updating or archiving this item.'),
    content: z.string(),
    extendValues: knowledgeMetadataSchema,
    fullContent: z.string().optional(),
    nextOffset: z.number().nullable().optional(),
  });

export const knowledgeCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});
export type KnowledgeCursor = z.infer<typeof knowledgeCursorSchema>;
