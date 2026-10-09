import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, id } from './base.js';
import {
  providerInputSchema,
  providerUpdateSchema,
  modelInputSchema,
  modelUpdateSchema,
  modelDefaultsSchema,
  type ProviderSummary,
  type ProviderDetail,
  type ProviderModel,
  type SyncResult,
  type ModelDefaults,
  type AvailableModels,
} from '../providers.js';

export const providersContract = {
  available: procedure
    .route({ method: 'GET', path: '/models', inputStructure: 'detailed' })
    .output(type<AvailableModels>()),
  list: procedure
    .route({
      method: 'GET',
      path: '/admin/providers',
      inputStructure: 'detailed',
    })
    .output(type<ProviderSummary[]>()),
  get: procedure
    .route({
      method: 'GET',
      path: '/admin/providers/{providerId}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ providerId: id }) }))
    .output(type<ProviderDetail>()),
  create: procedure
    .route({
      method: 'POST',
      path: '/admin/providers',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ body: providerInputSchema }))
    .output(type<ProviderSummary>()),
  update: procedure
    .route({
      method: 'PATCH',
      path: '/admin/providers/{providerId}',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ providerId: id }),
        body: providerUpdateSchema,
      }),
    )
    .output(type<ProviderSummary>()),
  remove: procedure
    .route({
      method: 'DELETE',
      path: '/admin/providers/{providerId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ providerId: id }) }))
    .output(type<void>()),
  models: procedure
    .route({
      method: 'GET',
      path: '/admin/providers/{providerId}/models',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ providerId: id }) }))
    .output(type<ProviderModel[]>()),
  createModel: procedure
    .route({
      method: 'POST',
      path: '/admin/providers/{providerId}/models',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(
      z.object({
        params: z.object({ providerId: id }),
        body: modelInputSchema,
      }),
    )
    .output(type<ProviderModel>()),
  updateModel: procedure
    .route({
      method: 'PATCH',
      path: '/admin/providers/{providerId}/models',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ providerId: id }),
        query: z.object({ modelId: modelInputSchema.shape.id }),
        body: modelUpdateSchema,
      }),
    )
    .output(type<ProviderModel>()),
  removeModel: procedure
    .route({
      method: 'DELETE',
      path: '/admin/providers/{providerId}/models',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(
      z.object({
        params: z.object({ providerId: id }),
        query: z.object({ modelId: modelInputSchema.shape.id }),
      }),
    )
    .output(type<void>()),
  sync: procedure
    .route({
      method: 'POST',
      path: '/admin/providers/{providerId}/sync',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ providerId: id }) }))
    .output(type<SyncResult>()),
  defaults: procedure
    .route({
      method: 'GET',
      path: '/admin/settings/models',
      inputStructure: 'detailed',
    })
    .output(type<ModelDefaults>()),
  saveDefaults: procedure
    .route({
      method: 'PUT',
      path: '/admin/settings/models',
      inputStructure: 'detailed',
    })
    .input(z.object({ body: modelDefaultsSchema }))
    .output(type<ModelDefaults>()),
};
