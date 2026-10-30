import type { BaseAgent } from '@aime/shared/agents';
import { assistantAgent } from './code.js';
import { defaultAgent } from './default.js';
import { codeReviewerAgent } from './code-reviewer.js';
import { botAgent } from './bot-agent.js';

// Register code-owned agents by name; keep their persisted IDs stable.
export const agentRegistry: Readonly<Record<string, BaseAgent>> = {
  default: defaultAgent,
  code: assistantAgent,
  codeReviewer: codeReviewerAgent,
  bot: botAgent,
};
export const agentIds = Object.keys(agentRegistry).filter(
  (key) => !agentRegistry[key].hidden,
);
export const fallbackAgentId = assistantAgent.id;

/** Internal lookup, including reserved IDs that must never fall back to storage. */
export function getCodeAgent(id: string): BaseAgent | undefined {
  const agent = Object.hasOwn(agentRegistry, id)
    ? agentRegistry[id]
    : Object.values(agentRegistry).find((item) => item.id === id);
  return agent ? structuredClone(agent) : undefined;
}

/** Resolve only agents available to ordinary chats and native delegation. */
export function getAgent(id: string = 'default'): BaseAgent | undefined {
  const agent = getCodeAgent(id);
  return agent?.hidden ? undefined : agent;
}
