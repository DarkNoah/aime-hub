import type { ChatUsage } from '@aime/shared/threads';
import { useTranslation } from 'react-i18next';
import { Gauge } from 'lucide-react';
import {
  Context,
  ContextIcon,
  ContextTrigger,
  ContextContent,
} from '@/components/ai-elements/context';
import { Button } from '@/components/ui/button';
import { formatTokens } from './format-tokens';

export function ChatContextUsage({ usage }: { usage: ChatUsage }) {
  const { t, i18n } = useTranslation();
  const usedTokens = usage.totalTokens ?? 0;
  const maxTokens = usage.maxTokens;
  const hasLimit =
    maxTokens !== null && Number.isFinite(maxTokens) && maxTokens > 0;
  const hasProgress =
    hasLimit &&
    usage.totalTokens !== undefined &&
    Number.isFinite(usage.totalTokens) &&
    usage.totalTokens >= 0;
  const percent = hasProgress
    ? (usedTokens / maxTokens).toLocaleString(i18n.language, {
        style: 'percent',
        maximumFractionDigits: 1,
      })
    : '—';
  const progressLabel = t('chat.usage.contextProgress', { percent });
  return (
    <Context usedTokens={usedTokens} maxTokens={hasLimit ? maxTokens : 1}>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <ContextTrigger>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-7 gap-0 p-0 text-xs text-muted-foreground @xl/chat:w-auto @xl/chat:gap-1.5 @xl/chat:px-2"
            aria-label={hasProgress ? progressLabel : t('chat.usage.title')}
          >
            <span className="hidden font-mono tabular-nums @xl/chat:inline">
              {formatTokens(usage.totalTokens, i18n.language)}
            </span>
            {hasProgress ? (
              <ContextIcon
                aria-label={progressLabel}
                aria-valuetext={percent}
              />
            ) : (
              <Gauge className="size-4" />
            )}
          </Button>
        </ContextTrigger>
      </div>
      <ContextContent
        side="top"
        align="end"
        className="w-52 min-w-0 max-w-[calc(100vw-2rem)] p-3"
      >
        {hasProgress ? (
          <div className="space-y-1 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span>{t('chat.usage.context')}</span>
              <span className="font-mono tabular-nums">{percent}</span>
            </div>
            <p className="font-mono tabular-nums text-muted-foreground">
              {formatTokens(usedTokens, i18n.language)} /{' '}
              {formatTokens(maxTokens, i18n.language)}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t(hasLimit ? 'chat.usage.unavailable' : 'chat.usage.unknownLimit')}
          </p>
        )}
      </ContextContent>
    </Context>
  );
}
