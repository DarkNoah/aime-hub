import { api } from '../../../lib/rpc.js';
import type { z } from 'zod';
import { invalidateAvailableModels } from '../../../features/models/resource';
import {
  modelInputSchema,
  modelUpdateSchema,
  providerUpdateSchema,
  type ModelDefaults,
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
  PROVIDER_HAS_MODELS: 'errors.providerHasModels',
  PROVIDER_CONFIG_ONLY: 'errors.providerConfigOnly',
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

// Keep invalidation next to successful writes, shared by all provider editors.
async function write<T>(request: Promise<T>) {
  const result = await request;
  invalidateAvailableModels();
  return result;
}
export const providerApi = {
  list: (signal?: AbortSignal) => api.providers.list(undefined, { signal }),
  get: (providerId: string, signal?: AbortSignal) =>
    api.providers.get({ params: { providerId } }, { signal }),
  models: (providerId: string, signal?: AbortSignal) =>
    api.providers.models({ params: { providerId } }, { signal }),
  create: (body: z.input<typeof providerInputSchema>) =>
    write(api.providers.create({ body })),
  update: (providerId: string, body: z.input<typeof providerUpdateSchema>) =>
    write(api.providers.update({ params: { providerId }, body })),
  remove: (providerId: string) =>
    write(api.providers.remove({ params: { providerId } })),
  createModel: (providerId: string, body: z.input<typeof modelInputSchema>) =>
    write(api.providers.createModel({ params: { providerId }, body })),
  updateModel: (
    providerId: string,
    modelId: string,
    body: z.input<typeof modelUpdateSchema>,
  ) =>
    write(
      api.providers.updateModel({
        params: { providerId },
        query: { modelId },
        body,
      }),
    ),
  removeModel: (providerId: string, modelId: string) =>
    write(
      api.providers.removeModel({ params: { providerId }, query: { modelId } }),
    ),
  sync: (providerId: string) =>
    write(api.providers.sync({ params: { providerId } })),
  defaults: (signal?: AbortSignal) =>
    api.providers.defaults(undefined, { signal }),
  saveDefaults: (body: ModelDefaults) =>
    write(api.providers.saveDefaults({ body })),
};

// Metadata is not editable here; omit it so PATCH preserves its saved value.
const providerFormSchema = providerInputSchema.omit({ metadata: true });

export function providerFormInput(
  form: FormData,
): Omit<ProviderInput, 'metadata'> {
  const apiKey = String(form.get('apiKey') ?? '').trim();
  const parsed = providerFormSchema.safeParse({
    name: form.get('name'),
    type: form.get('type') ?? 'openai',
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
