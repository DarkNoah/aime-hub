import type { KnowledgeField, KnowledgeMetadata } from '@aime/shared/knowledge';
import { ThreadError } from '../threads/errors.js';

export function validateMetadata(
  fields: KnowledgeField[],
  values: KnowledgeMetadata,
): KnowledgeMetadata {
  const result: KnowledgeMetadata = {};
  for (const [key, value] of Object.entries(values)) {
    const field = fields.find((f) => f.name === key);
    if (!field) throw new ThreadError('KNOWLEDGE_METADATA_INVALID', 400);
    if (value === null) {
      result[key] = null;
      continue;
    }
    const valid =
      field.type === 'json' ||
      (field.type === 'text' && typeof value === 'string') ||
      (field.type === 'number' &&
        typeof value === 'number' &&
        Number.isFinite(value)) ||
      (field.type === 'boolean' && typeof value === 'boolean') ||
      (field.type === 'date' &&
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) &&
        Number.isFinite(Date.parse(value))) ||
      (field.type === 'blob' &&
        typeof value === 'string' &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value,
        ));
    if (!valid) throw new ThreadError('KNOWLEDGE_METADATA_INVALID', 400);
    result[key] =
      field.type === 'date' ? new Date(value as string).toISOString() : value;
  }
  return result;
}
export function fieldParameter(
  field: KnowledgeField,
  value: KnowledgeMetadata[string] | undefined,
) {
  if (value === undefined || value === null) return null;
  if (field.type === 'json') return JSON.stringify(value);
  if (field.type === 'blob') return Buffer.from(value as string, 'base64');
  return value;
}
export const fieldTypes: Record<KnowledgeField['type'], string> = {
  text: 'text',
  number: 'double precision',
  boolean: 'boolean',
  date: 'timestamptz',
  json: 'jsonb',
  blob: 'bytea',
};
