import type { LanguageModelUsage } from 'ai';
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
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextCacheUsage,
} from '@/components/ai-elements/context';
import { Button } from '@/components/ui/button';

function UsageRow({ label, tokens }: { label: string; tokens?: number }) {
  const { i18n } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">
        {tokens === undefined ? '—' : tokens.toLocaleString(i18n.language)}
      </span>
    </div>
  );
}

export function ChatContextUsage({ usage }: { usage: ChatUsage }) {
  const { t } = useTranslation();
  const usedTokens = usage.totalTokens ?? 0;
  const hasLimit = usage.maxTokens !== null && usage.maxTokens > 0;
  const modelId = usage.model.slice(usage.model.indexOf('/') + 1);
  const contextUsage: LanguageModelUsage = {
    ...usage,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheCreationInputTokens,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: usage.reasoningTokens,
    },
  };
  return (
    <Context
      usedTokens={usedTokens}
      maxTokens={hasLimit ? usage.maxTokens! : 1}
      usage={contextUsage}
    >
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {hasLimit && usage.totalTokens !== undefined ? (
          <ContextTrigger
            className="h-7 gap-1.5 px-2 text-xs"
            aria-label={t('chat.usage.title')}
          />
        ) : (
          <ContextTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground"
              aria-label={t('chat.usage.title')}
            >
              <Gauge className="size-4" />
            </Button>
          </ContextTrigger>
        )}
      </div>
      <ContextContent
        side="top"
        align="end"
        className="w-72 max-w-[calc(100vw-2rem)]"
      >
        <div className="space-y-1 p-3">
          <p className="text-xs font-medium">{t('chat.usage.title')}</p>
          <p className="truncate text-xs text-muted-foreground" title={modelId}>
            {modelId}
          </p>
        </div>
        {hasLimit && usage.totalTokens !== undefined ? (
          <ContextContentHeader />
        ) : (
          <ContextContentHeader>
            <p className="text-xs text-muted-foreground">
              {t(
                hasLimit ? 'chat.usage.unavailable' : 'chat.usage.unknownLimit',
              )}
            </p>
          </ContextContentHeader>
        )}
        <ContextContentBody className="space-y-2">
          <ContextInputUsage>
            <UsageRow
              label={t('chat.usage.input')}
              tokens={usage.inputTokens}
            />
          </ContextInputUsage>
          <ContextOutputUsage>
            <UsageRow
              label={t('chat.usage.output')}
              tokens={usage.outputTokens}
            />
          </ContextOutputUsage>
          {usage.reasoningTokens !== undefined && (
            <ContextReasoningUsage>
              <UsageRow
                label={t('chat.usage.reasoning')}
                tokens={usage.reasoningTokens}
              />
            </ContextReasoningUsage>
          )}
          {usage.cachedInputTokens !== undefined && (
            <ContextCacheUsage>
              <UsageRow
                label={t('chat.usage.cache')}
                tokens={usage.cachedInputTokens}
              />
            </ContextCacheUsage>
          )}
          {usage.cacheCreationInputTokens !== undefined && (
            <UsageRow
              label={t('chat.usage.cacheWrite')}
              tokens={usage.cacheCreationInputTokens}
            />
          )}
        </ContextContentBody>
        <ContextContentFooter className="block">
          <UsageRow label={t('chat.usage.total')} tokens={usage.totalTokens} />
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}
