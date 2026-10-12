import {
  FILE_UPLOAD_MAX_SIZE,
  type FileUploadSession,
} from '@aime/shared/files';

export type UploadOptions = {
  signal: AbortSignal;
  onProgress: (percent: number) => void;
  onFinishing: () => void;
};

export class FileUploadError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new FileUploadError(
      body?.code ?? 'FILE_UPLOAD_FAILED',
      response.status,
    );
  }
  return response.json();
}

async function retry<T>(
  action: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await action();
    } catch (error) {
      if (
        signal.aborted ||
        attempt >= 2 ||
        !(
          error instanceof TypeError ||
          (error instanceof FileUploadError &&
            (error.status >= 500 || [408, 429].includes(error.status)))
        )
      )
        throw error;
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(finish, 500 * 2 ** attempt);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}

export async function uploadFile(
  threadId: string,
  directory: string,
  file: File,
  options: UploadOptions,
) {
  if (file.size > FILE_UPLOAD_MAX_SIZE)
    throw new FileUploadError('FILE_UPLOAD_TOO_LARGE');
  const path = directory ? `${directory}/${file.name}` : file.name;
  const base = `/api/threads/${encodeURIComponent(threadId)}/files/uploads`;
  const { signal, onProgress, onFinishing } = options;
  const session = await request<FileUploadSession>(base, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, size: file.size }),
  });
  const url = `${base}/${encodeURIComponent(session.id)}`;
  try {
    let offset = session.offset;
    if (
      !Number.isSafeInteger(session.chunkSize) ||
      session.chunkSize <= 0 ||
      offset !== 0
    )
      throw new FileUploadError('FILE_UPLOAD_CHUNK');
    while (offset < file.size) {
      signal.throwIfAborted();
      const end = Math.min(offset + session.chunkSize, file.size);
      const chunk = file.slice(offset, end);
      const result = await retry(
        () =>
          request<{ offset: number }>(`${url}?offset=${offset}`, {
            method: 'PUT',
            signal,
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunk,
          }),
        signal,
      );
      if (result.offset !== end) throw new FileUploadError('FILE_UPLOAD_CHUNK');
      offset = end;
      onProgress(Math.min(99, Math.floor((offset / file.size) * 100)));
    }
    signal.throwIfAborted();
    onFinishing();
    const result = await retry(
      () =>
        request<{ path: string }>(`${url}/complete`, {
          method: 'POST',
          signal,
        }),
      signal,
    );
    onProgress(100);
    return result;
  } finally {
    // Independent of the aborted upload signal; server TTL handles a lost cleanup request.
    void fetch(url, {
      method: 'DELETE',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  }
}
