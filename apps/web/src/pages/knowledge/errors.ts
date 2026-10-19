import { apiErrorCode } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';

const errors: Record<string, TranslationKey> = {
  KNOWLEDGE_VERSION_CONFLICT: 'knowledge.errorVersionConflict',
  KNOWLEDGE_METADATA_INVALID: 'knowledge.errorMetadata',
  KNOWLEDGE_FILTER_INVALID: 'knowledge.errorMetadata',
  FORBIDDEN: 'knowledge.errorForbidden',
  PROJECT_NOT_FOUND: 'knowledge.errorForbidden',
  KNOWLEDGE_NOT_FOUND: 'knowledge.errorNotFound',
  KNOWLEDGE_BUSY: 'knowledge.errorBusy',
  KNOWLEDGE_SHARING_CHANGED: 'knowledge.errorSharingChanged',
  KNOWLEDGE_INVALID_MEMBERS: 'knowledge.errorMembers',
  KNOWLEDGE_LOCKED: 'knowledge.rebuildLockHint',
  KNOWLEDGE_FILE_TYPE: 'knowledge.errorFileType',
  KNOWLEDGE_TOO_LARGE: 'knowledge.errorTooLarge',
  KNOWLEDGE_EMPTY_CONTENT: 'knowledge.errorEmpty',
  KNOWLEDGE_PARSE_FAILED: 'knowledge.errorParse',
  KNOWLEDGE_EMBED_FAILED: 'knowledge.errorEmbed',
  KNOWLEDGE_IMAGE_MODEL_REQUIRED: 'knowledge.errorImageModel',
  KNOWLEDGE_IMAGE_EMBED_FAILED: 'knowledge.errorImageEmbed',
  KNOWLEDGE_INDEX_FAILED: 'knowledge.errorIndex',
  KNOWLEDGE_DIMENSION_CHANGED: 'knowledge.errorDimension',
  KNOWLEDGE_LIMIT: 'knowledge.errorLimit',
  INVALID_MODEL: 'knowledge.errorEmbed',
};
export function knowledgeError(error: unknown): TranslationKey {
  return (
    errors[typeof error === 'string' ? error : (apiErrorCode(error) ?? '')] ??
    'knowledge.error'
  );
}
