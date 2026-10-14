import { Agent, type AgentConfig } from '@mastra/core/agent';
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
  /** Resolve a subagent's model and execution defaults in the current session. */
  subagentOptions?: (
    config: AgentDefinition,
  ) => Pick<
    AgentConfig,
    'model' | 'instructions' | 'defaultOptions' | 'workspace'
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
    resolveSubagent = getAgent,
    ...runtime
  } = options;
  delete runtime.versionId;
  // Only the main Agent may delegate. Children never inspect their own references.
  const agents = allowSubagents
    ? Object.fromEntries(
        Object.entries(config.agents ?? {}).map(([name, reference]) => {
          // Mastra exposes this as the model-facing tool name `agent-${name}`.
          if (!/^[a-zA-Z0-9_-]{1,58}$/.test(name))
            throw new Error(
              `Invalid subagent name "${name}" on Agent "${config.id}"`,
            );
          const child = resolveSubagent(reference);
          if (!child)
            throw new Error(
              `Unknown subagent "${reference}" on Agent "${config.id}"`,
            );
          if (child.model && !subagentOptions)
            throw new Error(
              `Subagent "${reference}" needs subagentOptions to resolve its configured model`,
            );
          const childConfig = {
            ...child,
            model: child.model ?? config.model,
            agents: {},
          };
          return [
            name,
            buildAgentInstance(
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
            ),
          ];
        }),
      )
    : {};
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
