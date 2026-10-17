import { apiErrorCode } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';
import type { ToolId } from '@aime/shared/tools';

export function toolErrorKey(error: unknown, toolId?: ToolId): TranslationKey {
  if (error instanceof TypeError) return 'errors.network';
  switch (apiErrorCode(error)) {
    case 'UNAUTHORIZED':
      return 'errors.sessionExpired';
    case 'FORBIDDEN':
      return 'errors.forbidden';
    case 'INVALID_TRANSCRIPTION_MODEL':
      return 'tools.invalidTranscribeModel';
    case 'INVALID_SPEECH_MODEL':
      return 'tools.invalidSpeechModel';
    case 'INVALID_IMAGE_MODEL':
      return 'tools.invalidImageModel';
    case 'INVALID_OCR_MODEL':
      return 'tools.invalidOcrModel';
    case 'NOT_FOUND':
    case 'INVALID_TOOL_PROVIDER':
      return toolId === 'web_fetch'
        ? 'tools.invalidFetchProvider'
        : 'tools.invalidProvider';
    case 'VALIDATION_ERROR':
      return 'tools.invalid';
    default:
      return 'errors.generic';
  }
}
