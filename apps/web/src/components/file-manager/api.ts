import type { FileMutation } from '@aime/shared/files';
import { chatErrorKey } from '../chat/api.js';
import { api, apiErrorCode } from '../../lib/rpc.js';

const base = (id: string) => `/api/threads/${encodeURIComponent(id)}/files`;
export const filesApi = {
  list: (threadId: string, path: string, signal?: AbortSignal) =>
    api.files.list({ params: { threadId }, query: { path } }, { signal }),
  preview: (threadId: string, path: string, signal?: AbortSignal) =>
    api.files.preview({ params: { threadId }, query: { path } }, { signal }),
  search: (threadId: string, query: string, signal?: AbortSignal) =>
    api.files.search({ params: { threadId }, query: { query } }, { signal }),
  mutate: (threadId: string, input: FileMutation) =>
    api.files.mutate({ params: { threadId }, body: input }),
  raw: (id: string, path: string, download = false) =>
    `${base(id)}/raw?${new URLSearchParams({ path, ...(download ? { download: '1' } : {}) })}`,
};

export function fileErrorKey(error: unknown) {
  if (apiErrorCode(error)) {
    switch (apiErrorCode(error)) {
      case 'FILE_INVALID_PATH':
        return 'files.invalidName';
      case 'FILE_EXISTS':
        return 'files.exists';
      case 'FILE_NOT_FOUND':
        return 'files.notFound';
      case 'FILE_FORBIDDEN':
      case 'FILE_SYMLINK':
        return 'files.forbidden';
      case 'WORKSPACE_UNAVAILABLE':
        return 'files.unavailable';
      case 'UNAUTHORIZED':
      case 'FORBIDDEN':
      case 'THREAD_NOT_FOUND':
      case 'PROJECT_NOT_FOUND':
        return chatErrorKey(error);
    }
  }
  return error instanceof TypeError ? 'errors.network' : 'files.failed';
}
