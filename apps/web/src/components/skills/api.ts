import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { SKILL_ARCHIVE_MAX_BYTES, type SkillScan } from '@aime/shared/skills';

export type SkillScope = 'global' | 'personal';
export type SkillImportMode = 'skills' | 'project';
const clients = { global: api.skills, personal: api.personalSkills };
export const getSkillApi = (scope: SkillScope) => clients[scope];

const errorKeys = {
  SKILL_INVALID_URL: 'skills.invalidUrl',
  SKILL_SOURCE_NOT_FOUND: 'skills.sourceNotFound',
  SKILL_SOURCE_UNKNOWN: 'skills.sourceUnknown',
  SKILL_SOURCE_MISMATCH: 'skills.sourceMismatch',
  SKILL_UPDATE_SOURCE_NOT_FOUND: 'skills.updateSourceNotFound',
  SKILL_UPDATE_EMPTY: 'skills.updateEmpty',
  SKILL_DOWNLOAD_FAILED: 'skills.downloadFailed',
  SKILL_GIT_UNAVAILABLE: 'skills.gitUnavailable',
  SKILL_UNSAFE_REPOSITORY: 'skills.unsafeRepository',
  SKILL_UNSAFE_PATH: 'skills.unsafePath',
  SKILL_SCAN_EXPIRED: 'skills.scanExpired',
  SKILL_INVALID_SELECTION: 'skills.invalidSelection',
  SKILL_CONFLICT: 'skills.conflict',
  SKILL_NOT_FOUND: 'skills.notFound',
  SKILL_GROUP_CHANGED: 'skills.groupChanged',
  SKILL_ARCHIVE_INVALID: 'skills.archiveInvalid',
  SKILL_ARCHIVE_TOO_LARGE: 'skills.archiveTooLarge',
  SKILL_ARCHIVE_UNSAFE: 'skills.archiveUnsafe',
  SKILL_PROJECT_MANAGED: 'skills.projectManaged',
  SKILL_SHARED_READ_ONLY: 'skills.sharedReadOnly',
  PROJECT_ARCHIVED: 'skills.shareProjectArchived',
  ABORTED: 'skills.archiveCancelled',
  VALIDATION_ERROR: 'skills.invalidUrl',
  UNAUTHORIZED: 'errors.sessionExpired',
  FORBIDDEN: 'errors.forbidden',
} as const satisfies Record<string, TranslationKey>;

export async function uploadSkillArchive(
  scope: SkillScope,
  file: File,
  signal: AbortSignal,
  mode: SkillImportMode = 'skills',
): Promise<SkillScan> {
  if (!/\.(zip|skill)$/i.test(file.name) || !file.size)
    throw { code: 'SKILL_ARCHIVE_INVALID' };
  if (file.size > SKILL_ARCHIVE_MAX_BYTES)
    throw { code: 'SKILL_ARCHIVE_TOO_LARGE' };
  const body = new FormData();
  body.set('file', file);
  body.set('mode', mode);
  const response = await fetch(
    scope === 'global' ? '/api/admin/skills/archives' : '/api/skills/archives',
    { method: 'POST', credentials: 'same-origin', body, signal },
  );
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw {
      code:
        result?.code ??
        (response.status === 413
          ? 'SKILL_ARCHIVE_TOO_LARGE'
          : 'SKILL_ARCHIVE_INVALID'),
    };
  if (!result || typeof result.id !== 'string' || !Array.isArray(result.skills))
    throw new Error('Invalid archive scan response');
  return result as SkillScan;
}

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

// A lightweight input hint; the server remains authoritative for refs and paths.
export function isSkillSourceInput(input: string) {
  return /^(?:https:\/\/github\.com\/)?[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+(?:\/(?:tree|blob)\/[^\s?#]+)?\/?$/.test(
    input.trim(),
  );
}
