import type { FileMutation, FileScope } from '@aime/shared/files';
import { chatErrorKey } from '../chat/api.js';
import { api, apiErrorCode } from '../../lib/rpc.js';
import { uploadFile } from './upload.js';

const base = (id: string) => `/api/threads/${encodeURIComponent(id)}/files`;
export const filesApi = {
  upload: uploadFile,
  resolve: (threadId: string, path: string, signal?: AbortSignal) =>
    api.files.resolve({ params: { threadId }, query: { path } }, { signal }),
  list: (
    threadId: string,
    path: string,
    signal?: AbortSignal,
    scope: FileScope = 'thread',
  ) =>
    api.files.list(
      { params: { threadId }, query: { path, scope } },
      { signal },
    ),
  preview: (
    threadId: string,
    path: string,
    signal?: AbortSignal,
    scope: FileScope = 'thread',
  ) =>
    api.files.preview(
      { params: { threadId }, query: { path, scope } },
      { signal },
    ),
  search: (
    threadId: string,
    query: string,
    signal?: AbortSignal,
    scope: FileScope = 'thread',
  ) =>
    api.files.search(
      { params: { threadId }, query: { query, scope } },
      { signal },
    ),
  mutate: (
    threadId: string,
    input: FileMutation,
    scope: FileScope = 'thread',
  ) =>
    api.files.mutate({ params: { threadId }, body: input, query: { scope } }),
  raw: (
    id: string,
    path: string,
    download = false,
    scope: FileScope = 'thread',
  ) =>
    `${base(id)}/raw?${new URLSearchParams({ path, ...(scope === 'shared' ? { scope } : {}), ...(download ? { download: '1' } : {}) })}`,
};

export function fileErrorKey(error: unknown) {
  if (apiErrorCode(error)) {
    switch (apiErrorCode(error)) {
      case 'FILE_UPLOAD_TOO_LARGE':
        return 'files.uploadTooLarge';
      case 'FILE_UPLOAD_LIMIT':
        return 'files.uploadLimit';
      case 'FILE_UPLOAD_EXPIRED':
        return 'files.uploadExpired';
      case 'FILE_UPLOAD_CHUNK':
      case 'FILE_UPLOAD_INCOMPLETE':
        return 'files.uploadIncomplete';
      case 'FILE_INVALID_PATH':
        return 'files.invalidName';
      case 'FILE_OUTSIDE_WORKSPACE':
        return 'files.outsideWorkspace';
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
