import { createKnowledgeSearchTool } from '../../mastra/tools/knowledge_search.js';
import { createKnowledgeTools } from '../../mastra/tools/knowledge.js';
import {
  createAutomationTools,
  type ResolveAutomations,
} from '../../mastra/tools/automations.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { AudioService } from '../audio/service.js';
import { createTranscribeTool } from '../../mastra/tools/transcribe.js';
import {
  createViewFileTool,
  type ResolvedOcrModel,
} from '../../mastra/tools/view_file.js';
import { createListVoicesTool } from '../../mastra/tools/list_voices.js';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import {
  enabledToolConfigSchema,
  toolIdSchema,
  toolConfigSchemas,
  type ToolConfig,
  type WebSearchConfig,
  type WebFetchConfig,
  type ImageGenConfig,
  type SpeechConfig,
  type ViewFileConfig,
} from '@aime/shared/tools';
import * as applicationTools from '../../mastra/tools/index.js';
import { createExecTool } from '../../mastra/tools/exec.js';
import { createWebSearchTool } from '../../mastra/tools/web_search.js';
import { createWebFetchTool } from '../../mastra/tools/web_fetch.js';
import {
  createImageGenTool,
  type ResolvedImageModel,
} from '../../mastra/tools/image_gen.js';
import type { SerpApiProvider } from '../../mastra/providers/serpapi.js';
import type { JinaAIProvider } from '../../mastra/providers/jina-ai.js';
import type { AssetService } from '../assets/service.js';
import {
  createSpeechTool,
  type ResolvedSpeechModel,
} from '../../mastra/tools/speech.js';

export type RegisteredToolId = string;
export type ToolDefaultConfigs = Partial<
  Record<string, { enabled?: boolean; [key: string]: unknown }>
> & {
  web_search?: Partial<WebSearchConfig>;
  web_fetch?: Partial<WebFetchConfig>;
  image_gen?: Partial<ImageGenConfig>;
  speech?: Partial<SpeechConfig>;
  view_file?: Partial<ViewFileConfig>;
};
type ToolDependencies = {
  audio?: AudioService;
  automations?: ResolveAutomations;
  knowledgeSearch?: KnowledgeService['searchContext'];
  knowledge?: KnowledgeService;
  disabledTools?: readonly string[];
  mcpTools?: () => Promise<ToolsInput>;
  pluginTools?: () => Promise<ToolsInput>;
  loadConfig?: (id: string) => Promise<unknown>;
  searchProvider?: (id: string, timeoutMs: number) => Promise<SerpApiProvider>;
  fetchProvider?: (id: string, timeoutMs: number) => Promise<JinaAIProvider>;
  imageModel?: (reference: string | null) => Promise<ResolvedImageModel>;
  speechModel?: (reference: string | null) => Promise<ResolvedSpeechModel>;
  ocrModel?: (reference: string | null) => Promise<ResolvedOcrModel>;
  recordAsset?: AssetService['record'];
};

/** Tool instances exported by the application entry point register themselves by ID. */
export function registerTools(
  tools: Record<
    string,
    ToolsInput[string] & { id: string; description?: string }
  >,
) {
  const registry = new Map<
    string,
    ToolsInput[string] & { id: string; description?: string }
  >();
  for (const tool of Object.values(tools)) {
    const id = toolIdSchema.parse(tool.id);
    if (registry.has(id)) throw new Error(`Duplicate tool ID: ${id}`);
    registry.set(id, tool);
  }
  return registry;
}
const registry = registerTools(applicationTools);
export const registeredToolIds: readonly string[] = [...registry.keys()];

export function parseToolConfig(id: string, input: unknown): ToolConfig {
  const tool = registry.get(id);
  if (!tool) throw new Error(`Unknown tool ID: ${id}`);
  const description = tool.description?.split('\n')[0] ?? id;
  switch (id) {
    case 'web_search':
      return {
        id,
        kind: id,
        description,
        config: toolConfigSchemas.web_search.parse(input),
      };
    case 'web_fetch':
      return {
        id,
        kind: id,
        description,
        config: toolConfigSchemas.web_fetch.parse(input),
      };
    case 'image_gen':
      return {
        id,
        kind: id,
        description,
        config: toolConfigSchemas.image_gen.parse(input),
      };
    case 'speech':
      return {
        id,
        kind: id,
        description,
        config: toolConfigSchemas.speech.parse(input),
      };
    case 'transcribe':
      return {
        id,
        kind: id,
        description,
        config: toolConfigSchemas.transcribe.parse(input),
      };
    case 'view_file':
      return {
        id,
        kind: id,
        description,
        config: toolConfigSchemas.view_file.parse(input),
      };
    default:
      return {
        id,
        kind: 'builtin',
        description,
        config: enabledToolConfigSchema.parse(input),
      };
  }
}

async function buildTool(
  id: string,
  defaults: ToolDefaultConfigs,
  dependencies: ToolDependencies,
) {
  const saved = await dependencies.loadConfig?.(id);
  const tool = parseToolConfig(id, {
    ...defaults[id],
    ...z.looseObject({}).parse(saved ?? {}),
  });
  if (!tool.config.enabled) return undefined;
  switch (tool.kind) {
    case 'web_search':
      return createWebSearchTool(tool.config, {
        resolveProvider: dependencies.searchProvider
          ? (providerId) =>
              dependencies.searchProvider!(providerId, tool.config.timeoutMs)
          : undefined,
      });
    case 'web_fetch':
      return createWebFetchTool(tool.config, {
        resolveProvider: dependencies.fetchProvider
          ? (providerId) =>
              dependencies.fetchProvider!(providerId, tool.config.timeoutMs)
          : undefined,
      });
    case 'image_gen':
      return createImageGenTool(tool.config, {
        resolveModel: dependencies.imageModel,
        recordAsset: dependencies.recordAsset,
      });
    case 'speech':
      return createSpeechTool(tool.config, {
        resolveModel: dependencies.speechModel,
        recordAsset: dependencies.recordAsset,
        audio: dependencies.audio,
      });
    case 'transcribe':
      return createTranscribeTool(tool.config, dependencies.audio);
    case 'view_file':
      return createViewFileTool(tool.config, {
        resolveModel: dependencies.ocrModel,
      });
    case 'builtin':
      if (id === 'list_voices')
        return createListVoicesTool(dependencies.audio?.voices);
      if (id.startsWith('automation_')) {
        const tools = createAutomationTools(dependencies.automations);
        if (id in tools) return tools[id as keyof typeof tools];
      }
      if (id.startsWith('knowledge_') && id !== 'knowledge_search') {
        const tools = createKnowledgeTools(dependencies.knowledge);
        if (id in tools) return tools[id as keyof typeof tools];
      }
      if (id === 'knowledge_search')
        return createKnowledgeSearchTool(
          dependencies.knowledgeSearch,
          dependencies.knowledge,
        );
      if (id === 'exec')
        return createExecTool({
          getTools: async () => {
            const [builtIn, mcp, plugins] = await Promise.all([
              buildTools(
                registeredToolIds.filter((toolId) => toolId !== 'exec'),
                defaults,
                dependencies,
              ),
              dependencies.mcpTools?.() ?? {},
              dependencies.pluginTools?.() ?? {},
            ]);
            return { ...mcp, ...plugins, ...builtIn };
          },
        });
      return registry.get(id)!;
  }
}

/** All registered tools are selected by default; saved settings override caller defaults. */
export async function buildTools(
  ids: readonly string[] = registeredToolIds,
  defaults: ToolDefaultConfigs = {},
  dependencies: ToolDependencies = {},
): Promise<ToolsInput> {
  const selected = [...new Set(ids)];
  for (const id of selected) {
    if (!registry.has(id)) throw new Error(`Unknown tool ID: ${id}`);
  }
  const entries = await Promise.all(
    selected
      .filter((id) => !dependencies.disabledTools?.includes(id))
      .map(async (id) => {
        const tool = await buildTool(id, defaults, dependencies);
        return tool ? [[id, tool] as const] : [];
      }),
  );
  return Object.fromEntries(entries.flat());
}
