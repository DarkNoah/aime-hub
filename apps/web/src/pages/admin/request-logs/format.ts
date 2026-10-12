import type { TranslationKey } from '@/i18n/config';
import { apiErrorCode } from '@/lib/rpc';

export function requestLogErrorKey(error: unknown): TranslationKey {
  if (error instanceof TypeError) return 'errors.network';
  switch (apiErrorCode(error)) {
    case 'UNAUTHORIZED':
      return 'errors.sessionExpired';
    case 'FORBIDDEN':
      return 'errors.forbidden';
    case 'NOT_FOUND':
      return 'requestLogs.notFound';
    default:
      return 'errors.generic';
  }
}

export function formatBody(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null) {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
