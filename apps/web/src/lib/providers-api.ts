import {
  modelInputSchema,
  providerInputSchema,
  modelReference,
  type ModelInput,
  type ProviderInput,
  type ProviderModel,
  type ProviderSummary,
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
  INVALID_METADATA: 'errors.providerMetadata',
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
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function metadataValue(form: FormData): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(form.get('metadata') ?? '{}'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw { code: 'INVALID_METADATA' };
  }
}

export function providerFormInput(form: FormData): ProviderInput {
  const apiKey = String(form.get('apiKey') ?? '').trim();
  const parsed = providerInputSchema.safeParse({
    name: form.get('name'),
    type: 'openai',
    baseUrl: String(form.get('baseUrl') ?? '').trim(),
    enabled: form.has('enabled'),
    metadata: metadataValue(form),
    ...(form.has('clearApiKey') ? { apiKey: '' } : apiKey ? { apiKey } : {}),
  });
  if (!parsed.success) throw { code: 'VALIDATION_ERROR' };
  return parsed.data;
}

export function modelFormInput(form: FormData): ModelInput {
  const nullableBoolean = (key: string) =>
    form.get(key) === 'true' ? true : form.get(key) === 'false' ? false : null;
  const limit = (key: string) =>
    String(form.get(key) ?? '').trim() === '' ? null : Number(form.get(key));
  const parsed = modelInputSchema.safeParse({
    id: form.get('id'),
    name: form.get('name'),
    description: String(form.get('description') ?? '') || null,
    displayName: String(form.get('displayName') ?? '').trim() || null,
    enabled: form.has('enabled'),
    deprecated: nullableBoolean('deprecated'),
    passTest: nullableBoolean('passTest'),
    modalitiesInput: form.getAll('modalitiesInput'),
    modalitiesOutput: form.getAll('modalitiesOutput'),
    reasoning: form.has('reasoning'),
    toolCall: form.has('toolCall'),
    limitContext: limit('limitContext'),
    limitOutput: limit('limitOutput'),
    metadata: metadataValue(form),
  });
  if (!parsed.success) throw { code: 'VALIDATION_ERROR' };
  return parsed.data;
}

export function modelOptions(
  providers: ProviderSummary[],
  models: ProviderModel[],
  imageOnly = false,
) {
  return models
    .filter(
      (model) =>
        model.enabled &&
        providers.some(
          (provider) => provider.id === model.providerId && provider.enabled,
        ) &&
        (!imageOnly || model.modalitiesOutput.includes('image')),
    )
    .map((model) => ({
      value: modelReference(model.providerId, model.id),
      label: `${providers.find((provider) => provider.id === model.providerId)!.name} / ${model.displayName || model.name} (${model.id})`,
    }));
}
