import { Agent, type AgentConfig } from '@mastra/core/agent';
import type { AgentDefinition } from '@aime/shared/agents';
import {
  buildTools,
  type ToolDefaultConfigs,
  type ToolService,
} from '../../modules/tools/service.js';

/** Per-session dependencies. The model is already resolved using the agent/chat defaults. */
export type AgentRuntimeOptions = Omit<
  AgentConfig,
  'id' | 'name' | 'instructions' | 'editor' | 'tools'
> & {
  instructions?: AgentConfig['instructions'];
  buildTools?: ToolService['buildTools'];
  defaultToolConfigs?: ToolDefaultConfigs;
  /** Pin a stored configuration that the runtime has already resolved. */
  versionId?: string;
};

export function buildAgent(
  config: AgentDefinition,
  options: AgentRuntimeOptions,
): Agent {
  const {
    buildTools: createTools = (ids, defaults, disabledTools) =>
      buildTools(ids, defaults, { disabledTools }),
    defaultToolConfigs,
    ...runtime
  } = options;
  delete runtime.versionId;
  return new Agent({
    ...runtime,
    id: config.id,
    name: config.name,
    description: config.description,
    instructions: runtime.instructions ?? config.instructions,
    tools: () =>
      createTools(undefined, defaultToolConfigs, config.disabledTools),
  });
}
