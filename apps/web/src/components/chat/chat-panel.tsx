import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Play, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatSettings, ThreadSummary } from '@aime/shared/threads';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { chatApi, chatErrorKey } from './api';
import { ChatComposer } from './chat-composer';
import { ChatMessage } from './chat-messages';
import { useThreadChat } from './use-thread-chat';
import { PersonalChatSettingsProvider } from './personal-chat-settings-provider';

export type ChatPanelProps = {
  threadId?: string | null;
  initialSettings?: ChatSettings;
  onThreadCreated?: (thread: ThreadSummary) => void;
  onThreadUpdated?: (thread: ThreadSummary) => void;
  onClose?: () => void;
  headerActions?: ReactNode;
  className?: string;
};

/** Container-sized chat surface. No router, viewport positioning, or page-shell dependencies.
 * Mount inside a page, Sheet, resizable panel, or floating dialog with a bounded height.
 */
export function ChatPanel(props: ChatPanelProps) {
  return (
    <PersonalChatSettingsProvider initialSettings={props.initialSettings}>
      <ChatPanelSession key={props.threadId ?? 'new'} {...props} />
    </PersonalChatSettingsProvider>
  );
}

function ChatPanelSession({
  threadId,
  onThreadCreated,
  onThreadUpdated,
  onClose,
  headerActions,
  className,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const [created, setCreated] = useState<ThreadSummary | null>(null);
  const draftThread = useRef<ThreadSummary | null>(null);
  const activeId = threadId ?? created?.id;
  const [retry, setRetry] = useState(0);
  const shell = cn(
    '@container/chat flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card',
    className,
  );
  if (activeId)
    return (
      <ExistingChat
        key={`${activeId}:${retry}`}
        threadId={activeId}
        onThreadUpdated={onThreadUpdated}
        onClose={onClose}
        headerActions={headerActions}
        className={shell}
        onRetry={() => setRetry((value) => value + 1)}
      />
    );
  return (
    <section className={shell} aria-label={t('chat.personal')}>
      <PanelHeader
        title={t('chat.new')}
        onClose={onClose}
        actions={headerActions}
      />
      <div className="flex min-h-0 flex-1 overflow-auto">
        <ConversationEmptyState
          title={t('chat.welcome')}
          description={t('chat.welcomeHint')}
          icon={<MessageSquare className="size-7 text-primary" />}
          className="m-auto max-w-lg [&_h3]:text-xl [&_p]:mt-3 [&_p]:leading-7"
        />
      </div>
      <ChatComposer
        onSend={async (input) => {
          // Create and accept the first message before navigation or unmount can occur.
          const thread =
            draftThread.current ??
            (await chatApi.create({
              model: input.model,
              reasoningEffort: input.reasoningEffort,
            }));
          draftThread.current = thread;
          const updated = await chatApi.run(thread.id, input);
          setCreated(updated);
          onThreadCreated?.(updated);
        }}
      />
    </section>
  );
}

function PanelHeader({
  title,
  status,
  onClose,
  actions,
}: {
  title: string;
  status?: ThreadSummary['status'];
  onClose?: () => void;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 @lg/chat:px-6">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold" title={title}>
          {title}
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('chat.personal')}
        </p>
      </div>
      {status && (
        <Badge variant={status === 'error' ? 'destructive' : 'secondary'}>
          {t(`chat.status.${status}`)}
        </Badge>
      )}
      {actions}
      {onClose && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <X />
        </Button>
      )}
    </header>
  );
}

function ExistingChat({
  threadId,
  onThreadUpdated,
  onClose,
  headerActions,
  className,
  onRetry,
}: ChatPanelProps & { threadId: string; onRetry: () => void }) {
  const { t } = useTranslation();
  const chat = useThreadChat(threadId, onThreadUpdated);
  const running = chat.thread?.status === 'running';
  const stopping = chat.thread?.status === 'stopping';
  const notifyError = (cause: unknown) => toast.error(t(chatErrorKey(cause)));
  return (
    <section className={className} aria-label={t('chat.personal')}>
      <PanelHeader
        title={chat.thread?.title || t('chat.new')}
        status={chat.thread?.status}
        onClose={onClose}
        actions={headerActions}
      />
      {!!(chat.error || chat.thread?.error) && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-sm"
        >
          <span className="flex-1">
            {t(chatErrorKey(chat.error ?? chat.thread?.error))}
          </span>
          {!!chat.error && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('chat.reconnect')}
            </Button>
          )}
        </div>
      )}
      <Conversation className="min-h-0" initial="instant" resize="instant">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6 @lg/chat:px-6">
          {chat.hasEarlier && (
            <Button
              variant="ghost"
              size="sm"
              className="mx-auto"
              disabled={chat.loadingHistory}
              onClick={() => void chat.loadEarlier().catch(notifyError)}
            >
              {t(chat.loadingHistory ? 'chat.loading' : 'chat.loadEarlier')}
            </Button>
          )}
          {!chat.thread && !chat.error && (
            <div
              role="status"
              aria-label={t('chat.loading')}
              className="space-y-5 motion-safe:animate-pulse"
            >
              <div className="h-4 w-1/3 rounded bg-muted" />
              <div className="h-20 w-4/5 rounded-lg bg-muted" />
              <div className="ml-auto h-14 w-3/5 rounded-lg bg-muted" />
            </div>
          )}
          {chat.messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              streaming={running && message.id === chat.activeMessageId}
            />
          ))}
          {chat.thread && !chat.messages.length && (
            <ConversationEmptyState
              title={t('chat.welcome')}
              description={t('chat.welcomeHint')}
            />
          )}
          {running && !chat.activeMessageId && (
            <p
              role="status"
              className="text-sm text-muted-foreground motion-safe:animate-pulse"
            >
              {t('chat.thinking')}
            </p>
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label={t('chat.toLatest')} />
      </Conversation>
      {!!chat.thread?.queue.length && (
        <div className="max-h-36 shrink-0 overflow-auto border-t bg-muted/30 px-4 py-2">
          <div className="flex items-center justify-between gap-2 text-xs font-medium">
            <span>{t('chat.queued', { count: chat.thread.queue.length })}</span>
            {!running && !stopping && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void chatApi.resume(threadId).catch(notifyError)}
              >
                <Play className="size-3" />
                {t('chat.resumeQueue')}
              </Button>
            )}
          </div>
          {chat.thread.queue.map((item) => (
            <div key={item.id} className="flex items-center gap-2 py-1 text-xs">
              <Badge variant="outline" className="shrink-0">
                {t(item.isImmediate ? 'chat.immediate' : 'chat.queuedLabel')}
              </Badge>
              <span className="min-w-0 flex-1 truncate">
                {item.text || t('chat.image')}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('chat.cancelQueued')}
                onClick={() =>
                  void chatApi.cancel(threadId, item.id).catch(notifyError)
                }
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
      {chat.thread && (
        <ChatComposer
          disabled={!chat.connected}
          running={running}
          stopping={stopping}
          onSend={chat.send}
          onStop={async () => {
            await chatApi.abort(threadId);
          }}
        />
      )}
    </section>
  );
}
