import type { ToolsInput } from '@mastra/core/agent';
import type { ToolExecutionContext } from '@mastra/core/tools';
import type {
  WebSearchConfig,
  WebFetchConfig,
  ImageGenConfig,
  SpeechConfig,
  ReadFileConfig,
  ExtractConfig,
} from '@aime/shared/tools';
export type RegisteredToolId = string;
export type RegisteredTool = ToolsInput[string] & { id: string };

export type ToolRegistryOptions = {
  /** false (default): every Agent. An array restricts use to these Agent IDs. */
  onlyAgents?: false | readonly string[];
  /** Select tools for this catalog. exec discovers its own complete catalog. */
  ids?: readonly string[];
  /** Exclusions apply to every source, including the catalog inside exec. */
  disabledTools?: readonly string[];
  /** Native Agent integration defers MCP/workspace/browser/skills until execution. */
  includeRuntimeTools?: boolean;
};
export type ToolDefaultConfigs = Partial<
  Record<string, { enabled?: boolean; [key: string]: unknown }>
> & {
  web_search?: Partial<WebSearchConfig>;
  web_fetch?: Partial<WebFetchConfig>;
  image_gen?: Partial<ImageGenConfig>;
  speech?: Partial<SpeechConfig>;
  read_file?: Partial<ReadFileConfig>;
  extract?: Partial<ExtractConfig>;
};
export type ToolDependencies = {
  /** Used before execution; execution context takes precedence when available. */
  agentId?: string;
  context?: Partial<ToolExecutionContext>;
  disabledTools?: readonly string[];
  loadConfig?: (id: string) => Promise<unknown>;
};
