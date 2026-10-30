import { apiErrorCode } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';

export function localAgentErrorKey(error: unknown): TranslationKey {
  if (error instanceof TypeError) return 'errors.network';
  const code = apiErrorCode(error);
  const errors: Record<string, TranslationKey> = {
    LOCAL_AGENT_EXISTS: 'localAgents.exists',
    LOCAL_AGENT_PATH_UNAVAILABLE: 'localAgents.pathUnavailable',
    AGENT_CONFLICT: 'agents.conflict',
    AGENT_NOT_FOUND: 'agents.notFound',
    PROJECT_NOT_FOUND: 'errors.forbidden',
    VALIDATION_ERROR: 'localAgents.invalid',
    FORBIDDEN: 'errors.forbidden',
    UNAUTHORIZED: 'errors.sessionExpired',
  };
  return (code && errors[code]) || 'errors.generic';
}
