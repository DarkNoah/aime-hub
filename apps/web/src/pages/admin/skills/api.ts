import type { TranslationKey } from '@/i18n/config';

const errorKeys = {
  SKILL_INVALID_URL: 'skills.invalidUrl',
  SKILL_SOURCE_NOT_FOUND: 'skills.sourceNotFound',
  SKILL_DOWNLOAD_FAILED: 'skills.downloadFailed',
  SKILL_GIT_UNAVAILABLE: 'skills.gitUnavailable',
  SKILL_REPOSITORY_LIMIT: 'skills.repositoryLimit',
  SKILL_FILE_LIMIT: 'skills.repositoryLimit',
  SKILL_UNSAFE_REPOSITORY: 'skills.unsafeRepository',
  SKILL_UNSAFE_PATH: 'skills.unsafePath',
  SKILL_SCAN_LIMIT: 'skills.scanLimit',
  SKILL_SCAN_EXPIRED: 'skills.scanExpired',
  SKILL_INVALID_SELECTION: 'skills.invalidSelection',
  SKILL_CONFLICT: 'skills.conflict',
  SKILL_NOT_FOUND: 'skills.notFound',
  VALIDATION_ERROR: 'skills.invalidUrl',
  UNAUTHORIZED: 'errors.sessionExpired',
  FORBIDDEN: 'errors.forbidden',
} as const satisfies Record<string, TranslationKey>;

export function skillErrorKey(error: unknown): TranslationKey {
  if (error instanceof TypeError) return 'errors.network';
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    Object.hasOwn(errorKeys, error.code)
  )
    return errorKeys[error.code as keyof typeof errorKeys];
  return 'errors.generic';
}

export async function skillRequest<T>(
  path = '',
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/admin/skills${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!response.ok)
    throw await response.json().catch(() => ({
      code:
        response.status === 401
          ? 'UNAUTHORIZED'
          : response.status === 403
            ? 'FORBIDDEN'
            : 'INTERNAL_ERROR',
    }));
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

// A lightweight input hint; the server remains authoritative for refs and paths.
export function isSkillSourceInput(input: string) {
  return /^(?:https:\/\/github\.com\/)?[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+(?:\/(?:tree|blob)\/[^\s?#]+)?\/?$/.test(
    input.trim(),
  );
}
