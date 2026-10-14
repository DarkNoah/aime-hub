import { z } from 'zod';

export const fileScopeSchema = z.enum(['thread', 'shared']);
export type FileScope = z.infer<typeof fileScopeSchema>;
export type WorkspaceFileReference = {
  scope: FileScope;
  path: string;
  kind: 'file' | 'directory';
};

export type FileEntry = {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  isMount?: boolean;
};
export type FileListing = { entries: FileEntry[]; truncated: boolean };
export type FilePreview = {
  path: string;
  size: number;
  modifiedAt: string;
  kind: 'text' | 'image' | 'audio' | 'video' | 'binary';
  mime: string;
  text?: string;
  truncated?: boolean;
};
export type FileSearch = {
  matches: (FileEntry & { line?: number; text?: string })[];
  truncated: boolean;
};
export const fileMutationSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('create'),
      path: z.string().max(2048),
      kind: z.enum(['file', 'directory']),
    })
    .strict(),
  z
    .object({
      operation: z.literal('rename'),
      path: z.string().max(2048),
      name: z.string().min(1).max(255),
    })
    .strict(),
  z
    .object({ operation: z.literal('delete'), path: z.string().max(2048) })
    .strict(),
]);
export type FileMutation = z.infer<typeof fileMutationSchema>;

export const FILE_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;
export const FILE_UPLOAD_MAX_SIZE = 1024 * 1024 * 1024;
export const fileUploadSchema = z
  .object({
    scope: fileScopeSchema.optional(),
    path: z.string().min(1).max(2048),
    size: z.number().int().min(0).max(FILE_UPLOAD_MAX_SIZE),
  })
  .strict();
export type FileUploadInput = z.infer<typeof fileUploadSchema>;
export type FileUploadSession = {
  id: string;
  chunkSize: number;
  offset: number;
};
