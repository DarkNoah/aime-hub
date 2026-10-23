import type { ToolsInput } from '@mastra/core/agent';
import {
  normalizeToolId,
  toolIdSchema,
  type ToolConfig,
} from '@aime/shared/tools';
import * as applicationTools from '../../mastra/tools/index.js';
import { agentAllowed, BaseTool, BuiltinTool } from './base.js';
import { toolSources } from './sources.js';
import type {
  RegisteredTool,
  ToolDefaultConfigs,
  ToolDependencies,
  ToolRegistryOptions,
} from './types.js';

export { BaseTool, BuiltinTool } from './base.js';
export type {
  RegisteredToolId,
  RegisteredTool,
  ToolDefaultConfigs,
  ToolDependencies,
  ToolRegistryOptions,
  ToolBuilder,
} from './types.js';

type ToolDefinition = BaseTool<ToolDependencies> & {
  readonly id: string;
  parseConfig(input: unknown): ToolConfig;
};

/** Application registrations must inherit the common construction contract. */
export function registerTools(tools: Record<string, ToolDefinition>) {
  const registry = new Map<string, ToolDefinition>();
  for (const tool of Object.values(tools)) {
    if (!(tool instanceof BuiltinTool))
      throw new Error('Tool definitions must extend BuiltinTool');
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
  return tool.parseConfig(input);
}

/** Aggregate BaseTool subclasses; each owns its configuration and dependencies. */
export async function getTools(
  config: ToolDefaultConfigs = {},
  dependencies: ToolDependencies = {},
  options: ToolRegistryOptions = {},
): Promise<RegisteredTool[]> {
  dependencies.context?.abortSignal?.throwIfAborted();
  if (!agentAllowed(dependencies, options) || options.ids?.length === 0)
    return [];
  const selected = options.ids && [
    ...new Set(options.ids.map(normalizeToolId)),
  ];
  const definitions = selected
    ? selected.flatMap((id) => (registry.has(id) ? [registry.get(id)!] : []))
    : [...registry.values()];
  const boundDependencies = { ...dependencies, getTools };
  const sources = await Promise.all(
    toolSources.map((source) =>
      source.getTools(config, boundDependencies, options),
    ),
  );
  const discovered = new Set(sources.flat().map((tool) => tool.id));
  const disabled = new Set(
    [
      ...(dependencies.disabledTools ?? []),
      ...(options.disabledTools ?? []),
    ].map(normalizeToolId),
  );
  for (const id of selected ?? []) {
    if (
      !registry.has(id) &&
      !dependencies.ownsPluginTool?.(id) &&
      !disabled.has(id) &&
      !discovered.has(id)
    )
      throw new Error(`Unknown tool ID: ${id}`);
  }
  const builtins = await Promise.all(
    definitions.map((tool) =>
      tool.getTools(config, boundDependencies, options),
    ),
  );
  const tools = new Map<string, RegisteredTool>();
  for (const tool of [...builtins, ...sources].flat()) {
    if (tools.has(tool.id)) throw new Error(`Duplicate tool ID: ${tool.id}`);
    tools.set(tool.id, tool);
  }
  dependencies.context?.abortSignal?.throwIfAborted();
  return selected
    ? selected.flatMap((id) => (tools.has(id) ? [tools.get(id)!] : []))
    : [...tools.values()];
}

/** Convert the public array to the mapping required by Mastra Agent.tools. */
export function toToolsInput(tools: readonly RegisteredTool[]): ToolsInput {
  const entries = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    if (entries.has(tool.id)) throw new Error(`Duplicate tool ID: ${tool.id}`);
    entries.set(tool.id, tool);
  }
  return Object.fromEntries(entries);
}

/** Compatibility adapter for existing Agent callers; all assembly lives in getTools. */
export async function buildTools(
  ids?: readonly string[],
  defaults: ToolDefaultConfigs = {},
  dependencies: ToolDependencies = {},
): Promise<ToolsInput> {
  return toToolsInput(
    await getTools(defaults, dependencies, { ids, includeRuntimeTools: false }),
  );
}
