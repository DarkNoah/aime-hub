import type { ToolsInput } from '@mastra/core/agent';
import type { ToolExecutionContext } from '@mastra/core/tools';
import { z } from 'zod';
import {
  enabledToolConfigSchema,
  legacyToolIds,
  normalizeToolId,
  toolConfigSchemas,
  type ToolConfig,
} from '@aime/shared/tools';
import type {
  RegisteredTool,
  ToolDefaultConfigs,
  ToolDependencies,
  ToolRegistryOptions,
} from './tool-types.js';

export function agentAllowed(
  dependencies: ToolDependencies,
  options: ToolRegistryOptions,
) {
  const agentId = dependencies.context?.agent?.agentId ?? dependencies.agentId;
  return (
    options.onlyAgents === undefined ||
    options.onlyAgents === false ||
    (agentId !== undefined && options.onlyAgents.includes(agentId))
  );
}

function registeredTool(
  id: string,
  tool: ToolsInput[string],
  dependencies: ToolDependencies,
  options: ToolRegistryOptions,
): RegisteredTool {
  const scoped = Array.isArray(options.onlyAgents);
  if (!scoped && 'id' in tool && tool.id === id) return tool as RegisteredTool;
  const descriptors = Object.getOwnPropertyDescriptors(tool);
  descriptors.id = { value: id, enumerable: true, configurable: true };
  if (scoped && 'execute' in tool && tool.execute) {
    const execute = tool.execute;
    descriptors.execute = {
      configurable: true,
      enumerable: true,
      value: (input: unknown, context?: ToolExecutionContext) => {
        if (
          !agentAllowed(
            { ...dependencies, context: context ?? dependencies.context },
            options,
          )
        )
          throw new Error(`Tool ${id} is unavailable to this Agent`);
        return Reflect.apply(execute, tool, [input, context]);
      },
    };
  }
  // Map keys are authoritative (e.g. namespaced MCP/browser tools). Preserve
  // prototypes, schemas and hooks without mutating shared tool instances.
  return Object.create(
    Object.getPrototypeOf(tool),
    descriptors,
  ) as RegisteredTool;
}

/** Convert external names to stable IDs without changing third-party instances. */
export function toolArray(tools: ToolsInput): RegisteredTool[] {
  return Object.entries(tools).map(([id, tool]) =>
    registeredTool(id, tool, {}, {}),
  );
}

/** Every tool definition/source implements this array-returning construction contract. */
export abstract class BaseTool<D extends ToolDependencies = ToolDependencies> {
  /** Internal owners mount these explicitly; public registries must not expose them. */
  readonly hidden: boolean = false;
  /** Known IDs allow selection and exclusions to skip construction entirely. */
  readonly ids?: readonly string[];
  readonly deferred: boolean = false;

  async getTools(
    config: ToolDefaultConfigs = {},
    dependencies: D = {} as D,
    options: ToolRegistryOptions = {},
  ): Promise<RegisteredTool[]> {
    dependencies.context?.abortSignal?.throwIfAborted();
    if (!agentAllowed(dependencies, options)) return [];
    if (this.deferred && options.includeRuntimeTools === false) return [];
    const selected = options.ids && new Set(options.ids.map(normalizeToolId));
    const disabled = new Set(
      [
        ...(dependencies.disabledTools ?? []),
        ...(options.disabledTools ?? []),
      ].map(normalizeToolId),
    );
    const allowed = (id: string) =>
      !disabled.has(normalizeToolId(id)) &&
      (!selected || selected.has(normalizeToolId(id)));
    if (selected?.size === 0 || (this.ids && !this.ids.some(allowed)))
      return [];
    const tools = await this.createTools(config, dependencies, options);
    dependencies.context?.abortSignal?.throwIfAborted();
    const seen = new Set<string>();
    return tools
      .filter((tool) => allowed(tool.id))
      .map((tool) => {
        if (seen.has(tool.id)) throw new Error(`Duplicate tool ID: ${tool.id}`);
        seen.add(tool.id);
        return registeredTool(tool.id, tool, dependencies, options);
      });
  }

  protected abstract createTools(
    config: ToolDefaultConfigs,
    dependencies: D,
    options: ToolRegistryOptions,
  ): RegisteredTool[] | Promise<RegisteredTool[]>;
}

type ToolKind = ToolConfig['kind'];
const configSchemas = {
  builtin: enabledToolConfigSchema,
  ...toolConfigSchemas,
};
export type ToolSettings<K extends ToolKind> = Extract<
  ToolConfig,
  { kind: K }
>['config'];

function parseSettings<K extends ToolKind>(
  kind: K,
  input: unknown,
): ToolSettings<K> {
  return configSchemas[kind].parse(input) as ToolSettings<K>;
}

/** Schema defaults < caller defaults (including legacy IDs) < persisted settings. */
export async function loadToolSettings<K extends ToolKind>(
  id: string,
  kind: K,
  defaults: ToolDefaultConfigs,
  dependencies: ToolDependencies,
): Promise<ToolSettings<K>> {
  return parseSettings(kind, {
    ...(legacyToolIds[id] ? defaults[legacyToolIds[id]] : undefined),
    ...defaults[id],
    ...z.looseObject({}).parse((await dependencies.loadConfig?.(id)) ?? {}),
  });
}

/** A named tool adds persisted configuration to the base contract. */
export abstract class ConfiguredTool<
  K extends ToolKind = 'builtin',
  D extends ToolDependencies = ToolDependencies,
> extends BaseTool<D> {
  readonly id: string;
  readonly ids: readonly string[];
  readonly description: string;

  constructor(
    protected readonly tool: RegisteredTool,
    readonly kind: K = 'builtin' as K,
  ) {
    super();
    if (kind !== 'builtin' && tool.id !== kind)
      throw new Error(`Invalid tool configuration kind: ${tool.id} (${kind})`);
    this.id = tool.id;
    this.ids = [tool.id];
    this.description =
      ('description' in tool ? tool.description?.split('\n')[0] : undefined) ??
      tool.id;
  }

  parseConfig(input: unknown): ToolConfig {
    return {
      id: this.id,
      kind: this.kind,
      description: this.description,
      config: parseSettings(this.kind, input),
    } as ToolConfig;
  }

  protected async createTools(
    defaults: ToolDefaultConfigs,
    dependencies: D,
    options: ToolRegistryOptions,
  ) {
    const config = await loadToolSettings(
      this.id,
      this.kind,
      defaults,
      dependencies,
    );
    if (!config.enabled) return [];
    const tool = await this.create(config, dependencies, options, defaults);
    if (tool.id !== this.id)
      throw new Error(`Tool ID changed during construction: ${this.id}`);
    return [tool];
  }

  protected abstract create(
    config: ToolSettings<K>,
    dependencies: D,
    options: ToolRegistryOptions,
    defaults: ToolDefaultConfigs,
  ): RegisteredTool | Promise<RegisteredTool>;
}

/** Plugin definitions share the same construction and filtering contract as host tools. */
export abstract class PluginTool extends ConfiguredTool {
  // Preserve the full construction signature for plugins that override creation.
  protected create(
    config: ToolSettings<'builtin'>,
    dependencies: ToolDependencies,
    options: ToolRegistryOptions,
    defaults: ToolDefaultConfigs,
  ): RegisteredTool | Promise<RegisteredTool>;
  protected create(): RegisteredTool {
    return this.tool;
  }
}

export type {
  RegisteredToolId,
  RegisteredTool,
  ToolDefaultConfigs,
  ToolDependencies,
  ToolRegistryOptions,
} from './tool-types.js';
