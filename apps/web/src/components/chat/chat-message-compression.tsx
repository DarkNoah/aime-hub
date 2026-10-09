import { CheckCircle2, CircleAlert, Clock3, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Checkpoint,
  CheckpointIcon,
  CheckpointTrigger,
} from '@/components/ai-elements/checkpoint';
import { Badge } from '@/components/ui/badge';
import type { MessageCompression } from './message-compression';

export function ChatMessageCompression({
  compression,
  onPreview,
}: {
  compression: MessageCompression;
  onPreview?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const running = compression.status === 'running';
  const failed = compression.status === 'failed';
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
  const { tokensBefore, tokensAfter, durationMs } = compression;

  return (
    <Checkpoint
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="my-2 gap-2 [&>[data-slot=separator]]:min-w-4 [&>[data-slot=separator]]:flex-1"
    >
      <CheckpointIcon>
        {running ? (
          <LoaderCircle
            className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : compression.status === 'buffered' ? (
          <Clock3 className="size-4 shrink-0" aria-hidden="true" />
        ) : failed ? (
          <CircleAlert
            className="size-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : (
          <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
        )}
      </CheckpointIcon>
      <CheckpointTrigger
        asChild={!onPreview}
        onClick={onPreview}
        aria-label={onPreview ? t('chat.preview.openCompression') : undefined}
        className="h-auto min-w-0 justify-start whitespace-normal px-1 py-1 text-left hover:bg-muted/60"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Badge variant={failed ? 'destructive' : 'secondary'}>
            {t(`chat.compression.${compression.status}`)}
          </Badge>
          {tokensBefore !== undefined && (
            <span className="tabular-nums">
              {tokensAfter !== undefined
                ? t('chat.compression.tokenChange', {
                    before: number.format(tokensBefore),
                    after: number.format(tokensAfter),
                  })
                : t('chat.compression.tokens', {
                    tokens: number.format(tokensBefore),
                  })}
            </span>
          )}
          {durationMs !== undefined && (
            <span className="tabular-nums">
              {t('chat.compression.duration', {
                seconds: new Intl.NumberFormat(i18n.resolvedLanguage, {
                  maximumFractionDigits: 1,
                }).format(durationMs / 1000),
              })}
            </span>
          )}
        </span>
      </CheckpointTrigger>
    </Checkpoint>
  );
}
