import { invalidateAvailableModels } from '../../../features/models/resource';
import {
  modelInputSchema,
  providerInputSchema,
  type ModelInput,
  type ProviderInput,
} from '@aime/shared/providers';
import type { ErrorKey } from '@/i18n/config';

const errorKeys = {
  VALIDATION_ERROR: 'errors.providerValidation',
  NOT_FOUND: 'errors.providerNotFound',
  CONFLICT: 'errors.providerConflict',
  MODEL_IN_USE: 'errors.modelInUse',
  INVALID_MODEL: 'errors.invalidModel',
  UPSTREAM_ERROR: 'errors.providerUpstream',
  INVALID_URL: 'errors.providerUrl',
  RATE_LIMITED: 'errors.rateLimit',
  FORBIDDEN: 'errors.forbidden',
  UNAUTHORIZED: 'errors.sessionExpired',
  INTERNAL_ERROR: 'errors.server',
} as const satisfies Record<string, ErrorKey>;

export function providerErrorKey(error: unknown): ErrorKey {
  if (error instanceof TypeError) return 'errors.network';
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    Object.hasOwn(errorKeys, error.code)
  ) {
    return errorKeys[error.code as keyof typeof errorKeys];
  }
  return 'errors.generic';
}

export const providersPath = '/api/admin/providers';
export const defaultsPath = '/api/admin/settings/models';
export function providerPath(id: string) {
  return `${providersPath}/${encodeURIComponent(id)}`;
}
export function modelPath(providerId: string, id?: string) {
  const path = `${providerPath(providerId)}/models`;
  return id === undefined ? path : `${path}?modelId=${encodeURIComponent(id)}`;
}

export async function providerRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const fallback = {
      code:
        response.status === 401
          ? 'UNAUTHORIZED'
          : response.status === 403
            ? 'FORBIDDEN'
            : response.status === 429
              ? 'RATE_LIMITED'
              : 'INTERNAL_ERROR',
    };
    throw await response.json().catch(() => fallback);
  }
  if (
    options.method &&
    !['GET', 'HEAD'].includes(options.method.toUpperCase()) &&
    (path === providersPath || path.startsWith(`${providersPath}/`))
  ) {
    invalidateAvailableModels();
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

// Metadata is not editable here; omit it so PATCH preserves its saved value.
const providerFormSchema = providerInputSchema.omit({ metadata: true });

export function providerFormInput(
  form: FormData,
): Omit<ProviderInput, 'metadata'> {
  const apiKey = String(form.get('apiKey') ?? '').trim();
  const parsed = providerFormSchema.safeParse({
    name: form.get('name'),
    type: 'openai',
    baseUrl: String(form.get('baseUrl') ?? '').trim(),
    enabled: form.has('enabled'),
    ...(apiKey ? { apiKey } : {}),
  });
  if (!parsed.success) throw { code: 'VALIDATION_ERROR' };
  return parsed.data;
}

// Hidden fields belong to discovery/testing, not this form. Omitting them also
// preserves their persisted values on PATCH instead of applying create defaults.
const modelFormSchema = modelInputSchema.omit({
  metadata: true,
  deprecated: true,
  passTest: true,
});

export function modelFormInput(
  form: FormData,
): Omit<ModelInput, 'metadata' | 'deprecated' | 'passTest'> {
  const limit = (key: string) =>
    String(form.get(key) ?? '').trim() === '' ? null : Number(form.get(key));
  const parsed = modelFormSchema.safeParse({
    id: form.get('id'),
    name: form.get('name'),
    description: String(form.get('description') ?? '') || null,
    displayName: String(form.get('displayName') ?? '').trim() || null,
    enabled: form.has('enabled'),
    modalitiesInput: form.getAll('modalitiesInput'),
    modalitiesOutput: form.getAll('modalitiesOutput'),
    reasoning: form.has('reasoning'),
    toolCall: form.has('toolCall'),
    limitContext: limit('limitContext'),
    limitOutput: limit('limitOutput'),
  });
  if (!parsed.success) throw { code: 'VALIDATION_ERROR' };
  return parsed.data;
}
