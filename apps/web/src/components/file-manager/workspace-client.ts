import type { FileMutation, FileSave, FileScope } from '@aime/shared/files';
import { filesApi } from './api.js';
import type { UploadOptions } from './upload.js';

/** A stable workspace client. Changing the access thread does not invalidate file views. */
export function createWorkspaceFileClient(
  api = filesApi,
  scope: FileScope = 'thread',
) {
  let threadId: string | undefined;
  const accessThread = () => {
    if (!threadId) throw new Error('Workspace access requires a thread');
    return threadId;
  };
  return {
    setThread(id: string | undefined) {
      // A new-chat draft still uses the current project's existing workspace.
      if (id) threadId = id;
    },
    list: (path: string, signal?: AbortSignal) =>
      api.list(accessThread(), path, signal, scope),
    preview: (path: string, signal?: AbortSignal) =>
      api.preview(accessThread(), path, signal, scope),
    search: (query: string, signal?: AbortSignal) =>
      api.search(accessThread(), query, signal, scope),
    mutate: (input: FileMutation) => api.mutate(accessThread(), input, scope),
    save: (input: FileSave) => api.save(accessThread(), input, scope),
    // Capture the access thread once so every chunk uses the same upload session.
    upload: (directory: string, file: File, options: UploadOptions) =>
      api.upload(accessThread(), directory, file, options, scope),
    raw: (path: string, download = false) =>
      api.raw(accessThread(), path, download, scope),
  };
}
export type WorkspaceFileClient = ReturnType<typeof createWorkspaceFileClient>;
