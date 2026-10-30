import type { AvailableAgents } from '@aime/shared/agents';
import type { SlashCommandGroup } from './slash-command.js';

export function agentCommandGroup(
  catalog: AvailableAgents | undefined,
  selectedId: string | null,
  options: {
    label: string;
    defaultLabel: string;
    defaultDescription: string;
    disabled: boolean;
  },
): SlashCommandGroup {
  return {
    id: 'agents',
    label: options.label,
    sections: [
      {
        id: 'agents',
        items: catalog
          ? [
              {
                id: 'agent:__default__',
                name: options.defaultLabel,
                description: options.defaultDescription,
                action: 'agent',
                agentId: null,
                keywords: ['agent', 'default'],
                current: selectedId === null,
                disabled: options.disabled,
              },
              ...catalog.agents.map((agent) => ({
                id: `agent:${agent.id}`,
                name: agent.name,
                description: agent.description || agent.id,
                action: 'agent' as const,
                agentId: agent.id,
                keywords: ['agent', agent.id],
                current: agent.id === selectedId,
                disabled: options.disabled,
              })),
            ]
          : [],
      },
    ],
  };
}
