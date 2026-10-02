import { memo, useDeferredValue, useMemo } from 'react';
import type { UIMessage } from 'ai';
import { Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export const ChatRawMessages = memo(function ChatRawMessages({
  messages,
  loading,
  hasEarlier,
  onClose,
}: {
  messages: UIMessage[];
  loading: boolean;
  hasEarlier: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const deferredMessages = useDeferredValue(messages);
  // Preserve every field, including tool parts and metadata, without formatting during a drag.
  const json = useMemo(
    () => JSON.stringify(deferredMessages, null, 2),
    [deferredMessages],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {t('chat.inspector.title')}
        </h2>
        <Badge variant="outline">JSON</Badge>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={loading}
          aria-label={t('chat.inspector.copy')}
          title={t('chat.inspector.copy')}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                JSON.stringify(messages, null, 2),
              );
              toast.success(t('chat.inspector.copied'));
            } catch {
              toast.error(t('errors.generic'));
            }
          }}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div className="space-y-1 border-b px-4 py-3 text-xs leading-5 text-muted-foreground">
        <p>{t('chat.inspector.count', { count: messages.length })}</p>
        <p>{t('chat.inspector.hint')}</p>
        {hasEarlier && <p>{t('chat.inspector.earlier')}</p>}
      </div>
      {loading ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {t('chat.loading')}
        </p>
      ) : (
        <pre
          tabIndex={0}
          aria-label={t('chat.inspector.title')}
          className="min-h-0 flex-1 overflow-auto overscroll-contain p-4 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <code>{json}</code>
        </pre>
      )}
    </div>
  );
});
