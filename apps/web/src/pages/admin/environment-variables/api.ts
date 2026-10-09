import { apiErrorCode } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';

const errorKeys = {
  ENVIRONMENT_VARIABLE_CONFLICT: 'environmentVariables.conflict',
  ENVIRONMENT_VARIABLE_NOT_FOUND: 'environmentVariables.notFound',
  VALIDATION_ERROR: 'environmentVariables.invalid',
  UNAUTHORIZED: 'errors.sessionExpired',
  FORBIDDEN: 'errors.forbidden',
} as const satisfies Record<string, TranslationKey>;

export function environmentVariableErrorKey(error: unknown): TranslationKey {
  if (error instanceof TypeError) return 'errors.network';
  const code = apiErrorCode(error);
  return code && Object.hasOwn(errorKeys, code)
    ? errorKeys[code as keyof typeof errorKeys]
    : 'errors.generic';
}
