import { apiErrorCode } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';

const errors = {
  AGENT_READ_ONLY: 'agents.codeHint',
  AGENT_IS_DEFAULT: 'agents.isDefault',
  AGENT_NOT_FOUND: 'agents.notFound',
  AGENT_NOT_PUBLISHED: 'agents.notPublished',
  AGENT_CONFLICT: 'agents.conflict',
  AGENT_CONFIG_UNSUPPORTED: 'agents.unsupported',
  AGENT_SKILL_UNAVAILABLE: 'agents.skillUnavailable',
  AGENT_MODEL_UNAVAILABLE: 'agents.modelUnavailable',
  AGENT_SUBAGENT_UNAVAILABLE: 'agents.subagentUnavailable',
  VALIDATION_ERROR: 'agents.invalid',
  UNAUTHORIZED: 'errors.sessionExpired',
  FORBIDDEN: 'errors.forbidden',
} as const satisfies Record<string, TranslationKey>;

export function agentErrorKey(error: unknown): TranslationKey {
  if (error instanceof TypeError) return 'errors.network';
  const code = apiErrorCode(error);
  return code && Object.hasOwn(errors, code)
    ? errors[code as keyof typeof errors]
    : 'errors.generic';
}
