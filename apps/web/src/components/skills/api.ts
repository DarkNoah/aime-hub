import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';

export type SkillScope = 'global' | 'personal';
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

// A lightweight input hint; the server remains authoritative for refs and paths.
export function isSkillSourceInput(input: string) {
  return /^(?:https:\/\/github\.com\/)?[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+(?:\/(?:tree|blob)\/[^\s?#]+)?\/?$/.test(
    input.trim(),
  );
}
