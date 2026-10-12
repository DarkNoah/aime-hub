import type { DataSource } from 'typeorm';
import type { AssetService } from '../assets/service.js';
import { z } from 'zod';
import { Setting } from '@aime/db';
import { agentToolIds, type AgentToolId } from '@aime/shared/agents';
import {
  toolIds,
  toolConfigSchemas,
  type ToolId,
  type ToolConfig,
  type WebSearchConfig,
  type WebFetchConfig,
  type ImageGenConfig,
} from '@aime/shared/tools';
import type { ToolsInput } from '@mastra/core/agent';
import {
  askUserTool,
  taskWriteTool,
  taskUpdateTool,
  taskCompleteTool,
  taskCheckTool,
  submitPlanTool,
} from '@mastra/core/tools';
import { currTime } from '../../mastra/tools/clock.js';
import { sleep } from '../../mastra/tools/sleep.js';
import { createExecTool } from '../../mastra/tools/exec.js';
import type { ProviderService } from '../providers/service.js';
import { ProviderError } from '../providers/network.js';
import { SerpApiProvider } from '../../mastra/providers/serpapi.js';
import { createWebSearchTool } from '../../mastra/tools/web_search.js';
import { JinaAIProvider } from '../../mastra/providers/jina-ai.js';
import { createWebFetchTool } from '../../mastra/tools/web_fetch.js';
import {
  createImageGenTool,
  ImageGenerationError,
  type ResolvedImageModel,
} from '../../mastra/tools/image_gen.js';

export type RegisteredToolId = AgentToolId;
type ToolConfigs = {
  [Id in RegisteredToolId]: Id extends 'web_search'
    ? WebSearchConfig
    : Id extends 'web_fetch'
      ? WebFetchConfig
      : Id extends 'image_gen'
        ? ImageGenConfig
        : { enabled: boolean };
};
export type ToolDefaultConfigs = {
  [Id in RegisteredToolId]?: Partial<ToolConfigs[Id]>;
};
type ToolDependencies = {
  mcpTools?: () => Promise<ToolsInput>;
  loadConfig?: (id: RegisteredToolId) => Promise<unknown>;
  searchProvider?: (id: string, timeoutMs: number) => Promise<SerpApiProvider>;
  fetchProvider?: (id: string, timeoutMs: number) => Promise<JinaAIProvider>;
  imageModel?: (reference: string | null) => Promise<ResolvedImageModel>;
  recordAsset?: AssetService['record'];
};
type ToolRegistration<Id extends RegisteredToolId> = {
  schema: z.ZodType<ToolConfigs[Id]>;
  create: (
    config: ToolConfigs[Id],
    dependencies: ToolDependencies,
    defaults: ToolDefaultConfigs,
  ) => ToolsInput[string];
};
const enabledSchema = z.strictObject({ enabled: z.boolean().default(true) });
const builtin = (tool: ToolsInput[string]) => ({
  schema: enabledSchema,
  create: () => tool,
});

/** Application tools are constructed by ID; workspace/browser tools belong to Mastra. */
const toolRegistry: { [Id in RegisteredToolId]: ToolRegistration<Id> } = {
  exec: {
    schema: enabledSchema,
    create: (_config, dependencies, defaults) =>
      createExecTool({
        getTools: async () => {
          const [builtIn, mcp] = await Promise.all([
            buildTools(
              agentToolIds.filter((id) => id !== 'exec'),
              defaults,
              dependencies,
            ),
            dependencies.mcpTools?.() ?? {},
          ]);
          return { ...mcp, ...builtIn };
        },
      }),
  },
  web_search: {
    schema: toolConfigSchemas.web_search,
    create: (config, dependencies) =>
      createWebSearchTool(config, {
        resolveProvider: dependencies.searchProvider
          ? (id) => dependencies.searchProvider!(id, config.timeoutMs)
          : undefined,
      }),
  },
  web_fetch: {
    schema: toolConfigSchemas.web_fetch,
    create: (config, dependencies) =>
      createWebFetchTool(config, {
        resolveProvider: dependencies.fetchProvider
          ? (id) => dependencies.fetchProvider!(id, config.timeoutMs)
          : undefined,
      }),
  },
  curr_time: builtin(currTime),
  image_gen: {
    schema: toolConfigSchemas.image_gen,
    create: (config, dependencies) =>
      createImageGenTool(config, {
        resolveModel: dependencies.imageModel,
        recordAsset: dependencies.recordAsset,
      }),
  },
  sleep: builtin(sleep),
  ask_user: builtin(askUserTool),
  task_write: builtin(taskWriteTool),
  task_update: builtin(taskUpdateTool),
  task_complete: builtin(taskCompleteTool),
  task_check: builtin(taskCheckTool),
  submit_plan: builtin(submitPlanTool),
};

async function buildTool<Id extends RegisteredToolId>(
  id: Id,
  defaults: ToolDefaultConfigs,
  dependencies: ToolDependencies,
) {
  const registration = toolRegistry[id];
  const saved = await dependencies.loadConfig?.(id);
  const config = registration.schema.parse({
    ...defaults[id],
    ...z.looseObject({}).parse(saved ?? {}),
  });
  return config.enabled
    ? registration.create(config, dependencies, defaults)
    : undefined;
}

/** Saved settings override caller defaults; schema defaults fill omitted fields. */
export async function buildTools(
  ids: readonly RegisteredToolId[],
  defaults: ToolDefaultConfigs = {},
  dependencies: ToolDependencies = {},
): Promise<ToolsInput> {
  const selected = [...new Set(ids)];
  for (const id of selected) {
    if (!Object.hasOwn(toolRegistry, id))
      throw new Error(`Unknown tool ID: ${id}`);
  }
  const entries = await Promise.all(
    selected.map(async (id) => {
      const tool = await buildTool(id, defaults, dependencies);
      return tool ? [[id, tool] as const] : [];
    }),
  );
  return Object.fromEntries(entries.flat());
}

export class ToolService {
  constructor(
    private readonly database: DataSource,
    private readonly providers: Pick<
      ProviderService,
      'getProvider' | 'getDefaults' | 'getModel' | 'getProviderInstance'
    >,
    private readonly assets?: Pick<AssetService, 'record'>,
    private readonly mcp?: { getTools(): Promise<ToolsInput> },
  ) {}

  async get(id: ToolId): Promise<ToolConfig> {
    const row = await this.database
      .getRepository(Setting)
      .findOneBy({ id: `tool:${id}` });
    return this.parseConfig(id, row?.value ?? {});
  }

  async list(): Promise<ToolConfig[]> {
    return Promise.all(toolIds.map((id) => this.get(id)));
  }

  async update(
    id: ToolId,
    input: WebSearchConfig | WebFetchConfig | ImageGenConfig,
  ): Promise<ToolConfig> {
    const tool = this.parseConfig(id, input);
    const { config } = tool;
    if (tool.id === 'image_gen') {
      if (tool.config.enabled && tool.config.model) {
        try {
          await this.imageModel(tool.config.model);
        } catch {
          throw new ProviderError('INVALID_IMAGE_MODEL');
        }
      }
    } else if (tool.config.enabled && tool.config.providerId)
      await this.configuredProvider(
        tool.config.providerId,
        id === 'web_search' ? 'serpapi' : 'jina-ai',
      );
    await this.database
      .getRepository(Setting)
      .upsert({ id: `tool:${id}`, value: config }, ['id']);
    return tool;
  }

  private parseConfig(id: ToolId, input: unknown): ToolConfig {
    switch (id) {
      case 'web_search':
        return { id, config: toolConfigSchemas.web_search.parse(input) };
      case 'web_fetch':
        return { id, config: toolConfigSchemas.web_fetch.parse(input) };
      case 'image_gen':
        return { id, config: toolConfigSchemas.image_gen.parse(input) };
    }
  }

  private async imageModel(
    selected: string | null,
  ): Promise<ResolvedImageModel> {
    const reference =
      selected ?? (await this.providers.getDefaults()).imageModel;
    if (!reference)
      throw new ImageGenerationError(
        'Image generation model is not configured. Select a model in tool settings or set the default image generation model.',
      );
    try {
      const slash = reference.indexOf('/');
      if (slash < 1 || slash === reference.length - 1)
        throw new Error('Invalid model reference');
      const [model, provider] = await Promise.all([
        this.providers.getModel(reference),
        this.providers.getProviderInstance(reference.slice(0, slash)),
      ]);
      if (!model.enabled || !model.modalitiesOutput.includes('image'))
        throw new Error('Invalid image model');
      return {
        reference,
        model: provider.imageModel(reference.slice(slash + 1)),
      };
    } catch {
      throw new ImageGenerationError(
        'The image generation model is unavailable. Select an enabled model with image output in tool settings or update the default image generation model.',
      );
    }
  }

  private async configuredProvider(id: string, type: 'serpapi' | 'jina-ai') {
    const provider = await this.providers.getProvider(id);
    if (provider.type !== type || !provider.enabled || !provider.apiKey?.trim())
      throw new ProviderError('INVALID_TOOL_PROVIDER');
    return { ...provider, apiKey: provider.apiKey! };
  }

  private async searchProvider(id: string, timeoutMs: number) {
    const provider = await this.configuredProvider(id, 'serpapi');
    return new SerpApiProvider({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      timeoutMs,
    });
  }

  private async fetchProvider(id: string, timeoutMs: number) {
    const provider = await this.configuredProvider(id, 'jina-ai');
    return new JinaAIProvider({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey!,
      timeoutMs,
    });
  }

  async buildTools(
    ids: readonly RegisteredToolId[],
    defaults: ToolDefaultConfigs = {},
  ): Promise<ToolsInput> {
    return buildTools(ids, defaults, {
      // MCP tools are discovered only inside exec, never injected into the Agent.
      mcpTools: () => this.mcp?.getTools() ?? Promise.resolve({}),
      loadConfig: async (id) => {
        if (!(toolIds as readonly string[]).includes(id)) return undefined;
        const row = await this.database
          .getRepository(Setting)
          .findOneBy({ id: `tool:${id}` });
        return row?.value;
      },
      searchProvider: (id, timeoutMs) => this.searchProvider(id, timeoutMs),
      fetchProvider: (id, timeoutMs) => this.fetchProvider(id, timeoutMs),
      imageModel: (reference) => this.imageModel(reference),
      recordAsset: this.assets
        ? (input) => this.assets!.record(input)
        : undefined,
    });
  }
}
