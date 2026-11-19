import { useTranslation } from 'react-i18next';
import type { GroupChatAgent } from '@aime/shared/group-chats';
import { Badge } from '@/components/ui/badge';

export function WorkingAgents({ agents }: { agents: GroupChatAgent[] }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="me-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse"
        />
        {t('groupChat.status.running')}
      </span>
      {agents.map((agent) => (
        <Badge
          key={agent.id}
          variant="secondary"
          className="max-w-full bg-emerald-500/10 px-1.5 py-0 text-[11px] leading-4 wrap-anywhere whitespace-normal text-emerald-800 dark:text-emerald-300"
        >
          {agent.name}
        </Badge>
      ))}
    </div>
  );
}

export function AgentStatus({ agent }: { agent: GroupChatAgent }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant={
        agent.enabled && agent.status === 'failed' ? 'destructive' : 'secondary'
      }
    >
      {t(
        !agent.enabled
          ? 'groupChat.status.disabled'
          : `groupChat.status.${agent.status}`,
      )}
    </Badge>
  );
}
