import type {
  FileListing,
  FileMutation,
  FilePreview,
  FileSearch,
} from '@aime/shared/files';
import { chatRequest, ChatApiError, chatErrorKey } from '@/components/chat/api';

const base = (id: string) => `/api/threads/${encodeURIComponent(id)}/files`;
export const filesApi = {
  list: (id: string, path: string, signal?: AbortSignal) =>
    chatRequest<FileListing>(
      `?${new URLSearchParams({ path })}`,
      { signal },
      base(id),
    ),
  preview: (id: string, path: string, signal?: AbortSignal) =>
    chatRequest<FilePreview>(
      `/preview?${new URLSearchParams({ path })}`,
      { signal },
      base(id),
    ),
  search: (id: string, query: string, signal?: AbortSignal) =>
    chatRequest<FileSearch>(
      `/search?${new URLSearchParams({ query })}`,
      { signal },
      base(id),
    ),
  mutate: (id: string, input: FileMutation) =>
    chatRequest<{ path: string }>(
      '',
      { method: 'POST', body: JSON.stringify(input) },
      base(id),
    ),
  raw: (id: string, path: string, download = false) =>
    `${base(id)}/raw?${new URLSearchParams({ path, ...(download ? { download: '1' } : {}) })}`,
};

export function fileErrorKey(error: unknown) {
  if (error instanceof ChatApiError) {
    switch (error.code) {
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
