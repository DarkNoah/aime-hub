import type { TranslationKey } from '../../i18n/config.js';
import { chatErrorKey } from '../chat/api.js';

export function automationErrorKey(error: unknown): TranslationKey {
  const code =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'code' in error
        ? error.code
        : '';
  switch (code) {
    case 'AUTOMATION_CRON_INVALID':
      return 'automations.invalidCron';
    case 'AUTOMATION_THREAD_UNAVAILABLE':
      return 'automations.threadUnavailable';
    case 'AUTOMATION_NOT_FOUND':
      return 'automations.notFound';
    case 'AUTOMATION_ALREADY_RUNNING':
      return 'automations.alreadyRunning';
    case 'AUTOMATION_REMOVED':
      return 'automations.removed';
    case 'AUTOMATION_REQUIRES_INPUT':
      return 'automations.requiresInput';
    case 'AUTOMATION_RUN_FAILED':
      return 'automations.runFailed';
    case 'INTERNAL_ERROR':
      return 'errors.server';
    default: {
      const key = chatErrorKey(error);
      return key === 'chat.errors.failed' ? 'errors.generic' : key;
    }
  }
}
