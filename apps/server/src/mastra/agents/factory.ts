import { Agent, type AgentConfig } from '@mastra/core/agent';
import { createHash } from 'node:crypto';
import type { AgentDefinition } from '@aime/shared/agents';
import { getAgent } from './index.js';
import {
  buildTools,
  type ToolDefaultConfigs,
  type ToolService,
} from '../../modules/tools/service.js';

/** Per-session dependencies. The model is already resolved using the agent/chat defaults. */
export type AgentRuntimeOptions = Omit<
  AgentConfig,
  'id' | 'name' | 'instructions' | 'editor' | 'tools' | 'agents'
> & {
  instructions?: AgentConfig['instructions'];
  buildTools?: ToolService['buildTools'];
  defaultToolConfigs?: ToolDefaultConfigs;
  /** Pin a stored configuration that the runtime has already resolved. */
  versionId?: string;
  /** Resolve direct references already loaded by the Agent service. */
  resolveSubagent?: (reference: string) => AgentDefinition | undefined;
  /** Automatically discovered session-scoped definitions, refreshed by the native resolver. */
  localSubagents?: () => Promise<Record<string, AgentDefinition>>;
  /** Resolve a subagent's model and execution defaults in the current session. */
  subagentOptions?: (
    config: AgentDefinition,
  ) => Pick<
    AgentConfig,
    | 'model'
    | 'instructions'
    | 'defaultOptions'
    | 'workspace'
    | 'inputProcessors'
    | 'outputProcessors'
  >;
};

export function buildAgent(
  config: AgentDefinition,
  options: AgentRuntimeOptions,
): Agent {
  return buildAgentInstance(config, options, true);
}

function buildAgentInstance(
  config: AgentDefinition,
  options: AgentRuntimeOptions,
  allowSubagents: boolean,
): Agent {
  const {
    buildTools: createTools = (ids, defaults, disabledTools) =>
      buildTools(ids, defaults, { disabledTools }),
    defaultToolConfigs,
    subagentOptions,
    localSubagents,
    resolveSubagent = getAgent,
    ...runtime
  } = options;
  delete runtime.versionId;
  // Only the main Agent may delegate. Children never inspect their own references.
  const buildChild = (name: string, child: AgentDefinition) => {
    // Mastra exposes this as the model-facing tool name `agent-${name}`.
    if (!/^[a-zA-Z0-9_-]{1,58}$/.test(name))
      throw new Error(
        `Invalid subagent name "${name}" on Agent "${config.id}"`,
      );
    if (child.model && !subagentOptions)
      throw new Error(
        `Subagent "${child.id}" needs subagentOptions to resolve its configured model`,
      );
    const childConfig = {
      ...child,
      model: child.model ?? config.model,
      agents: {},
    };
    return buildAgentInstance(
      childConfig,
      {
        // Share session resources, but keep prompts, goals and execution hooks local.
        model: runtime.model,
        mastra: runtime.mastra,
        memory: runtime.memory,
        workspace: runtime.workspace,
        browser: runtime.browser,
        buildTools: createTools,
        defaultToolConfigs,
        subagentOptions,
        ...subagentOptions?.(childConfig),
      },
      false,
    );
  };
  const configuredAgents = allowSubagents
    ? Object.fromEntries(
        Object.entries(config.agents ?? {}).map(([name, reference]) => {
          const child = resolveSubagent(reference);
          if (!child)
            throw new Error(
              `Unknown subagent "${reference}" on Agent "${config.id}"`,
            );
          return [name, buildChild(name, child)];
        }),
      )
    : {};
  const agents =
    allowSubagents && localSubagents
      ? async () => {
          const local = await localSubagents();
          return {
            ...Object.fromEntries(
              Object.entries(local)
                // Explicit references retain their delegation names and precedence.
                .filter(([, child]) => child.id !== config.id)
                .map(([name, child]) => {
                  // Provider tool names cannot contain colons. Keep aliases stable and distinct.
                  const alias = name.includes(':')
                    ? `${name.replace(/:/g, '_').slice(0, 36)}_${createHash('sha256').update(name).digest('hex').slice(0, 20)}`
                    : name;
                  return [alias, child] as const;
                })
                .filter(([name]) => !Object.hasOwn(configuredAgents, name))
                .map(([name, child]) => [name, buildChild(name, child)]),
            ),
            ...configuredAgents,
          };
        }
      : configuredAgents;
  return new Agent({
    ...runtime,
    id: config.id,
    name: config.name,
    description: config.description,
    instructions: runtime.instructions ?? config.instructions,
    agents,
    tools: () =>
      createTools(undefined, defaultToolConfigs, config.disabledTools),
  });
}
