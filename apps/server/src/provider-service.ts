import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DataSource, EntityManager } from 'typeorm';
import { Provider, ProviderModel, Setting } from '@aime/db';
import {
  emptyModelDefaults,
  modelInputSchema,
  modelReference,
  type ModelDefaults,
  type ModelInput,
  type ProviderInput,
} from '@aime/shared/providers';
import { ProviderError, requestProviderJson } from './provider-network.js';

const settingsId = 'models';
const modelKeys = ['defaultModel', 'fastModel', 'imageModel'] as const;
const discoverySchema = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(256) })).max(10000),
});
const catalogSchema = z.record(
  z.string(),
  z.object({ models: z.record(z.string(), z.record(z.string(), z.unknown())) }),
);
type RequestJson = typeof requestProviderJson;

function catalogLookup(catalog: unknown) {
  const parsed = catalogSchema.safeParse(catalog);
  const exact = new Map<string, Record<string, unknown>>();
  const suffix = new Map<string, Record<string, unknown>>();
  if (parsed.success) {
    for (const key of Object.keys(parsed.data).sort()) {
      for (const model of Object.values(parsed.data[key]!.models)) {
        if (typeof model.id !== 'string') continue;
        if (!exact.has(model.id)) exact.set(model.id, model);
        const last = model.id.split('/').at(-1)!;
        if (!suffix.has(last)) suffix.set(last, model);
      }
    }
  }
  return (id: string) => exact.get(id) ?? suffix.get(id.split('/').at(-1)!);
}

export function matchCatalogModel(
  id: string,
  catalog: unknown,
): Partial<ModelInput> {
  return catalogFields(catalogLookup(catalog)(id));
}

function catalogFields(
  raw: Record<string, unknown> | undefined,
): Partial<ModelInput> {
  if (!raw) return {};
  const modalities = raw.modalities as
    { input?: unknown; output?: unknown } | undefined;
  const limit = raw.limit as
    { context?: unknown; output?: unknown } | undefined;
  const fields = {
    name: raw.name,
    description: raw.description,
    modalitiesInput: modalities?.input,
    modalitiesOutput: modalities?.output,
    reasoning: raw.reasoning,
    toolCall: raw.tool_call,
    limitContext: limit?.context,
    limitOutput: limit?.output,
  };
  const result: Record<string, unknown> = { metadata: raw };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const schema =
      modelInputSchema.shape[key as keyof typeof modelInputSchema.shape];
    const checked = schema.safeParse(value);
    if (checked.success) result[key] = checked.data;
  }
  return result as Partial<ModelInput>;
}

export class ProviderService {
  private syncing = new Map<string, number>();
  private activeSyncs = new Set<string>();
  constructor(
    private database: DataSource,
    private requestJson: RequestJson = requestProviderJson,
  ) {}

  private async write<T>(
    action: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (manager) => {
      // Serialize configuration changes, including default references and sync commits.
      await manager.query('SELECT pg_advisory_xact_lock(72419021)');
      return action(manager);
    });
  }
  private async requireProvider(manager: EntityManager, id: string) {
    const provider = await manager.findOneBy(Provider, { id });
    if (!provider) throw new ProviderError('NOT_FOUND', 404);
    return provider;
  }
  private async defaults(manager: EntityManager): Promise<ModelDefaults> {
    return (
      ((await manager.findOneBy(Setting, { id: settingsId }))
        ?.value as ModelDefaults) ?? { ...emptyModelDefaults }
    );
  }
  private async assertUnused(
    manager: EntityManager,
    providerId: string,
    modelId?: string,
  ) {
    const settings = await this.defaults(manager);
    if (
      modelKeys.some((key) =>
        modelId === undefined
          ? settings[key]?.startsWith(`${providerId}/`)
          : settings[key] === modelReference(providerId, modelId),
      )
    )
      throw new ProviderError('MODEL_IN_USE', 409);
  }
  private publicProvider(provider: Provider, modelCount: number) {
    return {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      metadata: provider.metadata,
      hasApiKey: !!provider.apiKey,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
      modelCount,
    };
  }
  async listProviders() {
    const providers = await this.database
      .getRepository(Provider)
      .createQueryBuilder('provider')
      .addSelect('provider.apiKey')
      .orderBy('provider.createdAt', 'DESC')
      .getMany();
    const counts = await this.database
      .getRepository(ProviderModel)
      .createQueryBuilder('model')
      .select('model.providerId', 'providerId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('model.providerId')
      .getRawMany<{ providerId: string; count: string }>();
    return providers.map((provider) =>
      this.publicProvider(
        provider,
        Number(
          counts.find((count) => count.providerId === provider.id)?.count ?? 0,
        ),
      ),
    );
  }
  // Server-only persisted configuration, including credentials, for future model clients.
  async getProvider(id: string) {
    const provider = await this.database
      .getRepository(Provider)
      .createQueryBuilder('provider')
      .addSelect('provider.apiKey')
      .where('provider.id = :id', { id })
      .getOne();
    if (!provider) throw new ProviderError('NOT_FOUND', 404);
    const models = await this.database.manager.find(ProviderModel, {
      where: { providerId: id },
      order: { id: 'ASC' },
    });
    return { ...provider, models };
  }
  async getPublicProvider(id: string) {
    const provider = await this.getProvider(id);
    return {
      ...this.publicProvider(provider, provider.models.length),
      models: provider.models,
    };
  }
  async getModel(reference: string) {
    const slash = reference.indexOf('/');
    if (slash < 1) throw new ProviderError('INVALID_MODEL');
    const providerId = reference.slice(0, slash);
    await this.requireProvider(this.database.manager, providerId);
    const model = await this.database.manager.findOneBy(ProviderModel, {
      providerId,
      id: reference.slice(slash + 1),
    });
    if (!model) throw new ProviderError('NOT_FOUND', 404);
    return {
      ...model,
      supportsImageInput: model.modalitiesInput.includes('image'),
      supportsVideoInput: model.modalitiesInput.includes('video'),
      supportsAudioInput: model.modalitiesInput.includes('audio'),
      context: model.limitContext,
    };
  }
  async createProvider(input: ProviderInput) {
    const id = randomUUID();
    await this.write((manager) =>
      manager.save(
        Provider,
        manager.create(Provider, {
          ...input,
          id,
          apiKey: input.apiKey || null,
        }),
      ),
    );
    return this.getPublicProvider(id);
  }
  async updateProvider(id: string, input: Partial<ProviderInput>) {
    await this.write(async (manager) => {
      const provider = await this.requireProvider(manager, id);
      if (input.enabled === false) await this.assertUnused(manager, id);
      await manager.save(Provider, {
        ...provider,
        ...input,
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey || null } : {}),
      });
    });
    return this.getPublicProvider(id);
  }
  async deleteProvider(id: string) {
    await this.write(async (manager) => {
      await this.requireProvider(manager, id);
      await this.assertUnused(manager, id);
      await manager.softDelete(ProviderModel, { providerId: id });
      // Remove credentials even from the soft-deleted record.
      await manager.update(Provider, { id }, { apiKey: null });
      await manager.softDelete(Provider, { id });
    });
  }
  async createModel(providerId: string, input: ModelInput) {
    return this.write(async (manager) => {
      await this.requireProvider(manager, providerId);
      const old = await manager.findOne(ProviderModel, {
        where: { providerId, id: input.id },
        withDeleted: true,
      });
      if (old && !old.deletedAt) throw new ProviderError('CONFLICT', 409);
      return manager.save(
        ProviderModel,
        manager.create(ProviderModel, {
          ...old,
          ...input,
          providerId,
          deletedAt: null,
        }),
      );
    });
  }
  async updateModel(
    providerId: string,
    id: string,
    input: Partial<ModelInput>,
  ) {
    return this.write(async (manager) => {
      await this.requireProvider(manager, providerId);
      const model = await manager.findOneBy(ProviderModel, { providerId, id });
      if (!model) throw new ProviderError('NOT_FOUND', 404);
      const nextId = input.id ?? id;
      if (nextId !== id || input.enabled === false)
        await this.assertUnused(manager, providerId, id);
      const defaults = await this.defaults(manager);
      if (
        defaults.imageModel === modelReference(providerId, id) &&
        input.modalitiesOutput &&
        !input.modalitiesOutput.includes('image')
      )
        throw new ProviderError('MODEL_IN_USE', 409);
      if (nextId !== id) {
        const existing = await manager.findOne(ProviderModel, {
          where: { providerId, id: nextId },
          withDeleted: true,
        });
        if (existing && !existing.deletedAt)
          throw new ProviderError('CONFLICT', 409);
        await manager.softDelete(ProviderModel, { providerId, id });
      }
      return manager.save(
        ProviderModel,
        manager.create(ProviderModel, {
          ...model,
          ...input,
          id: nextId,
          deletedAt: null,
        }),
      );
    });
  }
  async deleteModel(providerId: string, id: string) {
    await this.write(async (manager) => {
      await this.requireProvider(manager, providerId);
      if (!(await manager.findOneBy(ProviderModel, { providerId, id })))
        throw new ProviderError('NOT_FOUND', 404);
      await this.assertUnused(manager, providerId, id);
      await manager.softDelete(ProviderModel, { providerId, id });
    });
  }
  getDefaults() {
    return this.defaults(this.database.manager);
  }
  async setDefaults(input: ModelDefaults) {
    return this.write(async (manager) => {
      for (const key of modelKeys) {
        const ref = input[key];
        if (!ref) continue;
        const slash = ref.indexOf('/');
        if (slash < 1) throw new ProviderError('INVALID_MODEL');
        const providerId = ref.slice(0, slash);
        const provider = await manager.findOneBy(Provider, {
          id: providerId,
          enabled: true,
        });
        const model = await manager.findOneBy(ProviderModel, {
          providerId,
          id: ref.slice(slash + 1),
          enabled: true,
        });
        if (
          !provider ||
          !model ||
          (key === 'imageModel' && !model.modalitiesOutput.includes('image'))
        )
          throw new ProviderError('INVALID_MODEL');
      }
      await manager.save(Setting, { id: settingsId, value: input });
      return input;
    });
  }
  async syncModels(providerId: string) {
    if (this.activeSyncs.has(providerId))
      throw new ProviderError('RATE_LIMITED', 429);
    this.activeSyncs.add(providerId);
    try {
      return await this.performSync(providerId);
    } finally {
      this.activeSyncs.delete(providerId);
    }
  }
  private async performSync(providerId: string) {
    const now = Date.now();
    for (const [id, until] of this.syncing)
      if (until <= now) this.syncing.delete(id);
    if (this.syncing.has(providerId))
      throw new ProviderError('RATE_LIMITED', 429);
    this.syncing.set(providerId, now + 60000);
    let provider: Awaited<ReturnType<ProviderService['getProvider']>>;
    try {
      provider = await this.getProvider(providerId);
    } catch (error) {
      this.syncing.delete(providerId);
      throw error;
    }
    const response = discoverySchema.safeParse(
      await this.requestJson(
        `${provider.baseUrl.replace(/\/+$/, '')}/models`,
        provider.apiKey ?? undefined,
      ),
    );
    if (
      !response.success ||
      response.data.data.some(
        ({ id }) => !modelInputSchema.shape.id.safeParse(id).success,
      )
    )
      throw new ProviderError('UPSTREAM_ERROR', 502);
    const ids = [...new Set(response.data.data.map(({ id }) => id))];
    let catalog: unknown = {};
    let catalogAvailable = false;
    try {
      catalog = await this.requestJson(
        'https://models.dev/api.json',
        undefined,
        20_000_000,
      );
      catalogAvailable = catalogSchema.safeParse(catalog).success;
    } catch {
      /* Discovery still succeeds when optional capability enrichment is unavailable. */
    }
    const lookupModel = catalogLookup(catalog);
    return this.write(async (manager) => {
      const current = await this.requireProvider(manager, providerId);
      if (current.updatedAt.getTime() !== provider.updatedAt.getTime())
        throw new ProviderError('CONFLICT', 409);
      const models = await manager.find(ProviderModel, {
        where: { providerId },
      });
      let added = 0;
      for (const id of ids) {
        // Preserve all manual edits on existing models; sync only their availability marker.
        if (models.some((model) => model.id === id)) continue;
        const input = modelInputSchema.parse({
          id,
          name: id,
          ...catalogFields(lookupModel(id)),
          deprecated: false,
        });
        const old = await manager.findOne(ProviderModel, {
          where: { providerId, id },
          withDeleted: true,
        });
        if (old?.deletedAt) continue;
        await manager.save(
          ProviderModel,
          manager.create(ProviderModel, {
            ...old,
            ...input,
            providerId,
            deletedAt: null,
          }),
        );
        added++;
      }
      const available = new Set(ids);
      for (const model of models)
        await manager.update(
          ProviderModel,
          { providerId, id: model.id },
          { deprecated: !available.has(model.id) },
        );
      return {
        added,
        deprecated: models.filter((model) => !available.has(model.id)).length,
        total: ids.length,
        catalogAvailable,
      };
    });
  }
}
