import type { ResolveIssues } from '../../mastra/tools/issue.js';
import type { ToolsInput } from '@mastra/core/agent';
import type {
  RegisteredTool,
  ToolDefaultConfigs,
  ToolDependencies as SharedToolDependencies,
  ToolRegistryOptions,
} from '@app/plugin-sdk/tools';
export type {
  RegisteredToolId,
  RegisteredTool,
  ToolDefaultConfigs,
  ToolRegistryOptions,
} from '@app/plugin-sdk/tools';
import type { KnowledgeService } from '../knowledge/service.js';
import type { AudioService } from '../audio/service.js';
import type { ResolveAutomations } from '../../mastra/tools/automations.js';
import type { ResolvedExtractionModel } from '../../mastra/tools/extract.js';
import type { FileContentModel } from '../files/content/types.js';
import type { ResolvedOcrModel } from '../../mastra/tools/read_file.js';
import type { ResolvedImageModel } from '../../mastra/tools/image_gen.js';
import type { ResolvedSpeechModel } from '../../mastra/tools/speech.js';
import type { BaseProvider } from '../../mastra/providers/base-provider.js';
import type { AssetService } from '../assets/service.js';

export type ToolBuilder = (
  config?: ToolDefaultConfigs,
  dependencies?: ToolDependencies,
  options?: ToolRegistryOptions,
) => Promise<RegisteredTool[]>;

export type ToolDependencies = SharedToolDependencies & {
  /** Injected by the registry so exec can rebuild the same catalog lazily. */
  getTools?: ToolBuilder;
  audio?: AudioService;
  automations?: ResolveAutomations;
  issues?: ResolveIssues;
  knowledgeSearch?: KnowledgeService['searchContext'];
  knowledge?: KnowledgeService;
  mcpTools?: () => Promise<ToolsInput>;
  pluginTools?: (
    config: ToolDefaultConfigs,
    dependencies: ToolDependencies,
    options: ToolRegistryOptions,
  ) => Promise<ToolsInput>;
  /** Includes disabled plugin tools so selecting a disabled tool returns no tool. */
  ownsPluginTool?: (id: string) => boolean;
  searchProvider?: (
    id: string | null,
    timeoutMs: number,
  ) => Promise<Pick<BaseProvider, 'id' | 'webSearch'>>;
  fetchProvider?: (
    id: string | null,
    timeoutMs: number,
  ) => Promise<Pick<BaseProvider, 'id' | 'webFetch'>>;
  imageModel?: (reference: string | null) => Promise<ResolvedImageModel>;
  speechModel?: (reference: string | null) => Promise<ResolvedSpeechModel>;
  ocrModel?: (reference: string | null) => Promise<ResolvedOcrModel>;
  fileInputModel?: (
    reference: string | null,
  ) => Promise<FileContentModel | null>;
  extractionModel?: (
    reference: string | null,
  ) => Promise<ResolvedExtractionModel>;
  recordAsset?: AssetService['record'];
};
