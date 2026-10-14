import { useTranslation } from 'react-i18next';
import type { AvailableAgent } from '@aime/shared/agents';

export function AgentDetails({
  agent,
}: {
  agent: Pick<AvailableAgent, 'id' | 'name' | 'description'>;
}) {
  const { t } = useTranslation();
  return (
    <span className="block min-w-0 flex-1 space-y-1">
      <span className="block break-words text-sm font-medium">
        {agent.name}
      </span>
      <span className="block break-all font-mono text-xs font-normal text-muted-foreground">
        {agent.id}
      </span>
      <span className="block break-words text-sm font-normal leading-5 text-muted-foreground">
        {agent.description || t('agents.noDescription')}
      </span>
    </span>
  );
}
