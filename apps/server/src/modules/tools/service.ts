import type { DataSource } from 'typeorm';
import { Setting } from '@aime/db';
import {
  toolIds,
  toolConfigSchemas,
  type ToolId,
  type ToolConfig,
  type WebSearchConfig,
  type WebFetchConfig,
} from '@aime/shared/tools';
import type { ToolsInput } from '@mastra/core/agent';
import type { ProviderService } from '../providers/service.js';
import { ProviderError } from '../providers/network.js';
import { SerpApiProvider } from '../../mastra/providers/serpapi.js';
import { createWebSearchTool } from '../../mastra/tools/web_search.js';
import { JinaAIProvider } from '../../mastra/providers/jina-ai.js';
import { createWebFetchTool } from '../../mastra/tools/web_fetch.js';

export class ToolService {
  constructor(
    private readonly database: DataSource,
    private readonly providers: Pick<ProviderService, 'getProvider'>,
  ) {}

  async get(id: ToolId): Promise<ToolConfig> {
    const row = await this.database
      .getRepository(Setting)
      .findOneBy({ id: `tool:${id}` });
    return id === 'web_search'
      ? { id, config: toolConfigSchemas.web_search.parse(row?.value ?? {}) }
      : { id, config: toolConfigSchemas.web_fetch.parse(row?.value ?? {}) };
  }

  async list(): Promise<ToolConfig[]> {
    return Promise.all(toolIds.map((id) => this.get(id)));
  }

  async update(
    id: ToolId,
    input: WebSearchConfig | WebFetchConfig,
  ): Promise<ToolConfig> {
    const tool: ToolConfig =
      id === 'web_search'
        ? { id, config: toolConfigSchemas.web_search.parse(input) }
        : { id, config: toolConfigSchemas.web_fetch.parse(input) };
    const { config } = tool;
    if (config.enabled && config.providerId)
      await this.configuredProvider(
        config.providerId,
        id === 'web_search' ? 'serpapi' : 'jina-ai',
      );
    await this.database
      .getRepository(Setting)
      .upsert({ id: `tool:${id}`, value: config }, ['id']);
    return tool;
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

  async createTools(): Promise<ToolsInput> {
    const tools: ToolsInput = {};
    for (const tool of await this.list()) {
      if (!tool.config.enabled) continue;
      if (tool.id === 'web_search') {
        tools.web_search = createWebSearchTool(tool.config, {
          resolveProvider: (id) =>
            this.searchProvider(id, tool.config.timeoutMs),
        });
      } else {
        tools.web_fetch = createWebFetchTool(tool.config, {
          resolveProvider: (id) =>
            this.fetchProvider(id, tool.config.timeoutMs),
        });
      }
    }
    return tools;
  }
}
