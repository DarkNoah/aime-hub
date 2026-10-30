import { Bot, ChevronRight, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatSubagentSummary } from '@aime/shared/chat-turns';
import { toolStatusLabels } from '@/components/ai-elements/tool-status';
import { Badge } from '@/components/ui/badge';

export function SubagentBadge({
  agent,
  onPreview,
  loading = false,
}: {
  agent: ChatSubagentSummary;
  onPreview?: () => void;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const name = agent.toolName.slice('agent-'.length);
  const running =
    agent.state === 'input-available' || agent.state === 'input-streaming';
  const failed =
    agent.state === 'output-error' || agent.state === 'output-denied';
  return (
    <Badge
      asChild
      variant={failed ? 'destructive' : 'outline'}
      className="max-w-full gap-2 px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-60"
    >
      <button
        type="button"
        disabled={loading || !onPreview}
        onClick={onPreview}
        aria-label={t('chat.subagent.open', {
          name,
          status: t(toolStatusLabels[agent.state]),
        })}
      >
        {loading || running ? (
          <LoaderCircle
            className="shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Bot className="shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">
          {t('chat.subagent.badge', { name })}
        </span>
        <span className="shrink-0 opacity-80">
          {t(toolStatusLabels[agent.state])}
        </span>
        <ChevronRight className="shrink-0" aria-hidden="true" />
      </button>
    </Badge>
  );
}
