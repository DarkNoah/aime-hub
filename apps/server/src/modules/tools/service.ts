import type { KnowledgeService } from '../knowledge/service.js';
import type { AudioService } from '../audio/service.js';
import type { ResolveAutomations } from '../../mastra/tools/automations.js';
import { enabledToolConfigSchema, legacyToolIds } from '@aime/shared/tools';
import type { PluginService } from '../plugins/service.js';
import type { DataSource } from 'typeorm';
import { Setting } from '@aime/db';
import type { ToolId, ToolConfig } from '@aime/shared/tools';
import {
  isOcrProvider,
  modelSupportsType,
  providerSupportsWebTool,
} from '@aime/shared/providers';
import {
  ReadFileError,
  type ResolvedOcrModel,
} from '../../mastra/tools/read_file.js';
import type { ToolsInput } from '@mastra/core/agent';
import type { AssetService } from '../assets/service.js';
import type { ProviderService } from '../providers/service.js';
import { ProviderError } from '../providers/network.js';
import { SerpApiProvider } from '../../mastra/providers/serpapi.js';
import { JinaAIProvider } from '../../mastra/providers/jina-ai.js';
import { DeepSeekProvider } from '../../mastra/providers/deepseek.js';
import {
  SpeechGenerationError,
  type ResolvedSpeechModel,
} from '../../mastra/tools/speech.js';
import {
  ImageGenerationError,
  type ResolvedImageModel,
} from '../../mastra/tools/image_gen.js';
import {
  buildTools,
  parseToolConfig,
  registeredToolIds,
  type RegisteredToolId,
  type ToolDefaultConfigs,
} from './registry.js';
export {
  buildTools,
  registeredToolIds,
  type RegisteredToolId,
  type ToolDefaultConfigs,
} from './registry.js';

export class ToolService {
  constructor(
    private readonly database: DataSource,
    private readonly providers: Pick<
      ProviderService,
      'getProvider' | 'getDefaults' | 'getModel' | 'getProviderInstance'
    >,
    private readonly assets?: Pick<AssetService, 'record'>,
    private readonly mcp?: { getTools(): Promise<ToolsInput> },
    private readonly plugins?: PluginService,
    private readonly knowledge?: KnowledgeService,
    private readonly automations?: ResolveAutomations,
    private readonly audio?: AudioService,
  ) {}

  async get(id: ToolId): Promise<ToolConfig> {
    if (this.plugins?.ownsTool(id))
      return (await this.plugins.toolConfigs()).find((tool) => tool.id === id)!;
    this.requireTool(id);
    return parseToolConfig(id, (await this.loadConfig(id)) ?? {});
  }

  private async loadConfig(id: ToolId) {
    const settings = this.database.getRepository(Setting);
    const row = await settings.findOneBy({ id: `tool:${id}` });
    // Preserve model, timeout and enabled state when a tool is renamed.
    const legacy =
      !row && legacyToolIds[id]
        ? await settings.findOneBy({ id: `tool:${legacyToolIds[id]}` })
        : undefined;
    return (row ?? legacy)?.value;
  }

  async list(): Promise<ToolConfig[]> {
    const [builtins, plugins] = await Promise.all([
      Promise.all(registeredToolIds.map((id) => this.get(id))),
      this.plugins?.toolConfigs() ?? [],
    ]);
    return [...builtins, ...plugins];
  }

  async update(id: ToolId, input: unknown): Promise<ToolConfig> {
    if (this.plugins?.ownsTool(id)) {
      const config = enabledToolConfigSchema.parse(input);
      await this.database
        .getRepository(Setting)
        .upsert({ id: `tool:${id}`, value: config }, ['id']);
      return this.get(id);
    }
    this.requireTool(id);
    const tool = parseToolConfig(id, input);
    const { config } = tool;
    if (tool.kind === 'image_gen') {
      if (tool.config.enabled && tool.config.model) {
        try {
          await this.imageModel(tool.config.model);
        } catch {
          throw new ProviderError('INVALID_IMAGE_MODEL');
        }
      }
    } else if (tool.kind === 'speech') {
      if (tool.config.enabled && tool.config.model) {
        try {
          await this.speechModel(tool.config.model);
        } catch {
          throw new ProviderError('INVALID_SPEECH_MODEL');
        }
      }
    } else if (tool.kind === 'transcriptions') {
      if (tool.config.enabled && tool.config.model) {
        try {
          const model = await this.providers.getModel(tool.config.model);
          if (!model.enabled || !modelSupportsType(model, 'asr'))
            throw new Error('Invalid ASR model');
          const provider = await this.providers.getProviderInstance(
            model.providerId,
          );
          provider.transcriptionModel(model.id);
        } catch {
          throw new ProviderError('INVALID_TRANSCRIPTION_MODEL');
        }
      }
    } else if (tool.kind === 'read_file') {
      if (tool.config.enabled && tool.config.model) {
        try {
          await this.ocrModel(tool.config.model);
        } catch {
          throw new ProviderError('INVALID_OCR_MODEL');
        }
      }
    } else if (
      tool.kind !== 'builtin' &&
      tool.config.enabled &&
      tool.config.providerId
    )
      await this.configuredProvider(tool.config.providerId, tool.kind);
    await this.database
      .getRepository(Setting)
      .upsert({ id: `tool:${id}`, value: config }, ['id']);
    return tool;
  }

  async setEnabled(id: ToolId, enabled: boolean): Promise<ToolConfig> {
    const current = await this.get(id);
    return this.update(id, { ...current.config, enabled });
  }

  private requireTool(id: string) {
    if (!registeredToolIds.includes(id))
      throw new ProviderError('NOT_FOUND', 404);
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

  private async configuredProvider(
    id: string,
    tool: 'web_search' | 'web_fetch',
  ) {
    const provider = await this.providers.getProvider(id);
    if (
      !providerSupportsWebTool(provider.type, tool) ||
      !provider.enabled ||
      !provider.apiKey?.trim()
    )
      throw new ProviderError('INVALID_TOOL_PROVIDER');
    return { ...provider, apiKey: provider.apiKey! };
  }

  private async ocrModel(selected: string | null): Promise<ResolvedOcrModel> {
    const reference = selected ?? (await this.providers.getDefaults()).ocrModel;
    if (!reference)
      throw new ReadFileError(
        'OCR_NOT_CONFIGURED',
        'Select an OCR model in read_file tool settings or set the default OCR model.',
      );
    try {
      const model = await this.providers.getModel(reference);
      if (!model.enabled || !modelSupportsType(model, 'ocr'))
        throw new Error('Invalid OCR model');
      const provider = await this.providers.getProviderInstance(
        model.providerId,
      );
      if (!isOcrProvider(provider.type))
        throw new Error('Invalid OCR provider');
      return { reference, model: provider.ocrModel(model.id) };
    } catch {
      throw new ReadFileError(
        'OCR_UNAVAILABLE',
        'The OCR model is unavailable. Select an enabled OCR model in read_file tool settings or update the default OCR model.',
      );
    }
  }

  private async speechModel(
    selected: string | null,
  ): Promise<ResolvedSpeechModel> {
    const reference =
      selected ?? (await this.providers.getDefaults()).speechModel;
    if (!reference)
      throw new SpeechGenerationError(
        'Speech model is not configured. Select a model in speech tool settings or set the default speech model.',
      );
    try {
      const slash = reference.indexOf('/');
      if (slash < 1 || slash === reference.length - 1)
        throw new Error('Invalid model reference');
      const [model, provider] = await Promise.all([
        this.providers.getModel(reference),
        this.providers.getProviderInstance(reference.slice(0, slash)),
      ]);
      if (!model.enabled || !modelSupportsType(model, 'speech'))
        throw new Error('Invalid speech model');
      return {
        reference,
        model: provider.speechModel(reference.slice(slash + 1), {
          modelName: model.name,
          metadata: model.metadata,
        }),
      };
    } catch {
      throw new SpeechGenerationError(
        'The speech model is unavailable. Select an enabled speech model in tool settings or update the default speech model.',
      );
    }
  }

  private async searchProvider(selected: string | null, timeoutMs: number) {
    const id =
      selected ?? (await this.providers.getDefaults()).webSearchProviderId;
    if (!id) throw new ProviderError('INVALID_TOOL_PROVIDER');
    const provider = await this.configuredProvider(id, 'web_search');
    if (provider.type === 'deepseek')
      return new DeepSeekProvider({ ...provider, timeoutMs });
    return new SerpApiProvider({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      timeoutMs,
    });
  }

  private async fetchProvider(selected: string | null, timeoutMs: number) {
    const id =
      selected ?? (await this.providers.getDefaults()).webFetchProviderId;
    if (!id) throw new ProviderError('INVALID_TOOL_PROVIDER');
    const provider = await this.configuredProvider(id, 'web_fetch');
    if (provider.type === 'deepseek')
      return new DeepSeekProvider({ ...provider, timeoutMs });
    return new JinaAIProvider({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey!,
      timeoutMs,
    });
  }

  async buildTools(
    ids?: readonly RegisteredToolId[],
    defaults: ToolDefaultConfigs = {},
    disabledTools: readonly string[] = [],
  ): Promise<ToolsInput> {
    const pluginTools = async () =>
      Object.fromEntries(
        Object.entries((await this.plugins?.tools(defaults)) ?? {}).filter(
          ([id]) => !disabledTools.includes(id),
        ),
      );
    const available = await pluginTools();
    const builtins = await buildTools(
      ids?.filter((id) => !this.plugins?.ownsTool(id)),
      defaults,
      {
        audio: this.audio,
        automations: this.automations,
        knowledgeSearch: this.knowledge?.searchContext.bind(this.knowledge),
        knowledge: this.knowledge,
        pluginTools,
        disabledTools,
        // MCP tools are discovered only inside exec, never injected into the Agent.
        mcpTools: () => this.mcp?.getTools() ?? Promise.resolve({}),
        loadConfig: (id) => this.loadConfig(id),
        searchProvider: (id, timeoutMs) => this.searchProvider(id, timeoutMs),
        fetchProvider: (id, timeoutMs) => this.fetchProvider(id, timeoutMs),
        imageModel: (reference) => this.imageModel(reference),
        speechModel: (reference) => this.speechModel(reference),
        ocrModel: (reference) => this.ocrModel(reference),
        recordAsset: this.assets
          ? (input) => this.assets!.record(input)
          : undefined,
      },
    );
    return {
      ...builtins,
      ...Object.fromEntries(
        Object.entries(available).filter(([id]) => !ids || ids.includes(id)),
      ),
    };
  }
}
