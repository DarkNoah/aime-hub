import type { ChatUsage } from '@aime/shared/threads';
import { useTranslation } from 'react-i18next';
import { Gauge } from 'lucide-react';
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
  ContextContentFooter,
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
  const breakdown = [
    ['input', usage.inputTokens],
    ['output', usage.outputTokens],
    ['reasoning', usage.reasoningTokens],
    ['cache', usage.cachedInputTokens],
    ['cacheWrite', usage.cacheCreationInputTokens],
  ] as const;
  return (
    <Context usedTokens={usedTokens} maxTokens={hasLimit ? maxTokens : 1}>
      {hasProgress ? (
        <ContextTrigger
          size="sm"
          className="size-7 gap-0 p-0 text-xs text-muted-foreground [&>span]:hidden @xl/chat:w-auto @xl/chat:gap-1.5 @xl/chat:px-2 @xl/chat:[&>span]:inline"
          aria-label={progressLabel}
        />
      ) : (
        <ContextTrigger>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-7 p-0 text-muted-foreground"
            aria-label={t('chat.usage.title')}
          >
            <Gauge className="size-4" />
          </Button>
        </ContextTrigger>
      )}
      <ContextContent
        side="top"
        align="end"
        className="w-72 min-w-0 max-w-[calc(100vw-2rem)]"
      >
        {hasProgress ? (
          <ContextContentHeader
            aria-label={progressLabel}
            title={`${usedTokens.toLocaleString(i18n.language)} / ${maxTokens.toLocaleString(i18n.language)} tokens`}
          />
        ) : (
          <ContextContentHeader>
            <p className="text-xs text-muted-foreground">
              {t(
                hasLimit ? 'chat.usage.unavailable' : 'chat.usage.unknownLimit',
              )}
            </p>
          </ContextContentHeader>
        )}
        {breakdown.some(([, tokens]) => tokens !== undefined) && (
          <ContextContentBody className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t('chat.usage.latestStep')}
            </p>
            {breakdown.map(([key, tokens]) =>
              tokens === undefined ? null : (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="text-muted-foreground">
                    {t(`chat.usage.${key}`)}
                  </span>
                  <span
                    className="font-mono tabular-nums"
                    title={tokens.toLocaleString(i18n.language)}
                  >
                    {formatTokens(tokens, i18n.language)}
                  </span>
                </div>
              ),
            )}
          </ContextContentBody>
        )}
        <ContextContentFooter>
          <span className="text-muted-foreground">
            {t('chat.usage.consumed')}
          </span>
          <span
            className="font-mono tabular-nums"
            title={usage.consumedTokens?.toLocaleString(i18n.language)}
          >
            {formatTokens(usage.consumedTokens, i18n.language)} tokens
          </span>
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}
