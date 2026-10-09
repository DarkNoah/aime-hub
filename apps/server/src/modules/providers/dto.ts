import {
  modelInputSchema,
  providerTypeSchema,
  type ProviderSummary,
  type ProviderDetail,
  type ProviderModel,
} from '@aime/shared/providers';
import type { ProviderService } from './service.js';

// RPC preserves Date values, so make the existing ISO-string API explicit.
export function providerSummary(
  value: Awaited<ReturnType<ProviderService['listProviders']>>[number],
): ProviderSummary {
  return {
    id: value.id,
    name: value.name,
    type: providerTypeSchema.parse(value.type),
    baseUrl: value.baseUrl,
    enabled: value.enabled,
    metadata: value.metadata,
    hasApiKey: value.hasApiKey,
    modelCount: value.modelCount,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}
export function providerModel(
  value: Awaited<ReturnType<ProviderService['createModel']>>,
): ProviderModel {
  return {
    ...modelInputSchema.strip().parse(value),
    providerId: value.providerId,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}
export function providerDetail(
  value: Awaited<ReturnType<ProviderService['getPublicProvider']>>,
): ProviderDetail {
  return { ...providerSummary(value), models: value.models.map(providerModel) };
}
