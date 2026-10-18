import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { UIMessage } from 'ai';
import { stringifyLogJson } from '@aime/shared/log-json';
import { Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import type { MessagePage } from '@aime/shared/threads';
import { chatApi, chatErrorKey } from './api';
import { mergeMessages } from './messages';
import { apiErrorCode } from '@/lib/rpc';

export const ChatRawMessages = memo(function ChatRawMessages({
  threadId,
  messages: overviewMessages,
  onClose,
}: {
  threadId?: string;
  messages: UIMessage[];
  loading: boolean;
  hasEarlier: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [history, setHistory] = useState<MessagePage<UIMessage> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const overview = useRef(overviewMessages);
  useEffect(() => {
    overview.current = overviewMessages;
  }, [overviewMessages]);
  useEffect(() => {
    if (!threadId) return;
    const abort = new AbortController();
    controller.current = abort;
    let lastOverview: UIMessage[] | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (lastOverview !== overview.current) {
        lastOverview = overview.current;
        try {
          const page = await chatApi.history(
            threadId,
            0,
            undefined,
            abort.signal,
          );
          if (abort.signal.aborted) return;
          setMessages((current) => mergeMessages(current, page.messages));
          setHistory((current) => current ?? page);
          setError(false);
        } catch (cause) {
          if (!abort.signal.aborted) {
            if (
              [
                'UNAUTHORIZED',
                'THREAD_NOT_FOUND',
                'PROJECT_NOT_FOUND',
              ].includes(apiErrorCode(cause) ?? '')
            ) {
              setMessages([]);
              setHistory(null);
            }
            setError(true);
            toast.error(t(chatErrorKey(cause)));
          }
        } finally {
          if (!abort.signal.aborted) setLoading(false);
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), 1000);
    };
    setLoading(true);
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [threadId, t, retry]);
  const hasEarlier = history?.hasMore ?? false;
  const loadEarlier = async () => {
    if (!threadId || !history || loading) return;
    const signal = controller.current?.signal;
    setLoading(true);
    try {
      const page = await chatApi.history(
        threadId,
        history.page + 1,
        history.anchor,
        signal,
      );
      if (signal?.aborted) return;
      setMessages((current) => mergeMessages(current, page.messages, true));
      setHistory(page);
    } catch (cause) {
      if (!signal?.aborted) toast.error(t(chatErrorKey(cause)));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };
  const deferredMessages = useDeferredValue(messages);
  // Shorten media payloads without mutating messages or formatting during a drag.
  const json = useMemo(
    () => stringifyLogJson(deferredMessages, 2),
    [deferredMessages],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
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
                stringifyLogJson(messages, 2),
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
        {hasEarlier && (
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void loadEarlier()}
          >
            {t('chat.loadEarlier')}
          </Button>
        )}
        {error && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t('chat.retry')}
          </Button>
        )}
      </div>
      {loading ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {t('chat.loading')}
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <pre
            tabIndex={0}
            aria-label={t('chat.inspector.title')}
            className="p-4 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <code>{json}</code>
          </pre>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}
    </div>
  );
});
