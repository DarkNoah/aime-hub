import { useTranslation } from 'react-i18next';
import type { GroupChatAgent } from '@aime/shared/group-chats';
import { Badge } from '@/components/ui/badge';

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
