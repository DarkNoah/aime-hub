import type { BaseAgent } from '@aime/shared/agents';
import { assistantAgent } from './code.js';
import { defaultAgent } from './default.js';
import { codeReviewerAgent } from './code-reviewer.js';

// Register code-owned agents by name; keep their persisted IDs stable.
export const agentRegistry: Readonly<Record<string, BaseAgent>> = {
  default: defaultAgent,
  code: assistantAgent,
  codeReviewer: codeReviewerAgent,
};
export const agentIds = Object.keys(agentRegistry);
export const fallbackAgentId = assistantAgent.id;

/** Resolve a registration name or a persisted Agent ID. */
export function getAgent(id: string = 'default'): BaseAgent | undefined {
  const agent = Object.hasOwn(agentRegistry, id)
    ? agentRegistry[id]
    : Object.values(agentRegistry).find((item) => item.id === id);
  return agent ? structuredClone(agent) : undefined;
}
