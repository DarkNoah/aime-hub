import type { CodeAgent } from '@aime/shared/agents';
import { assistantAgent } from './code.js';

// Register additional code-owned agents here; their IDs must remain stable.
export const codeAgents: readonly CodeAgent[] = [assistantAgent];
export const fallbackAgentId = assistantAgent.id;
export function getCodeAgent(id: string) {
  const agent = codeAgents.find((item) => item.id === id);
  return agent ? structuredClone(agent) : undefined;
}
