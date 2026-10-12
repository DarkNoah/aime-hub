import { z } from 'zod';

export const assetKinds = ['image', 'video', 'audio', 'file'] as const;
export const assetSorts = ['newest', 'oldest', 'name', 'largest'] as const;
export const assetQuerySchema = z.object({
  kind: z.enum(['all', ...assetKinds]).default('all'),
  search: z.string().trim().max(200).default(''),
  sort: z.enum(assetSorts).default('newest'),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type AssetQuery = z.infer<typeof assetQuerySchema>;
export const assetMetadataSchema = z
  .object({
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .catchall(z.json());
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;

export type GeneratedAsset = {
  id: string;
  threadId: string;
  resourceId: string;
  createdBy: string | null;
  path: string;
  name: string;
  kind: (typeof assetKinds)[number];
  mimeType: string;
  size: number;
  metadata: AssetMetadata;
  toolName: string;
  toolCallId: string | null;
  model: string | null;
  createdAt: string;
};
export type AssetList = { items: GeneratedAsset[]; nextCursor: string | null };

/** Server-produced metadata only. Never accept this payload from a client write API. */
export type GeneratedAssetInput = Pick<
  GeneratedAsset,
  | 'threadId'
  | 'resourceId'
  | 'createdBy'
  | 'path'
  | 'mimeType'
  | 'size'
  | 'toolName'
> &
  Partial<Pick<GeneratedAsset, 'metadata' | 'model' | 'toolCallId'>>;
