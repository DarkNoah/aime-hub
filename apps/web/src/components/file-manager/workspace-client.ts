import type { FileMutation } from '@aime/shared/files';
import { filesApi } from './api.js';
import type { UploadOptions } from './upload.js';

/** A stable workspace client. Changing the access thread does not invalidate file views. */
export function createWorkspaceFileClient(api = filesApi) {
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
      api.list(accessThread(), path, signal),
    preview: (path: string, signal?: AbortSignal) =>
      api.preview(accessThread(), path, signal),
    search: (query: string, signal?: AbortSignal) =>
      api.search(accessThread(), query, signal),
    mutate: (input: FileMutation) => api.mutate(accessThread(), input),
    // Capture the access thread once so every chunk uses the same upload session.
    upload: (directory: string, file: File, options: UploadOptions) =>
      api.upload(accessThread(), directory, file, options),
    raw: (path: string, download = false) =>
      api.raw(accessThread(), path, download),
  };
}
export type WorkspaceFileClient = ReturnType<typeof createWorkspaceFileClient>;
