import { isThreadActive } from '@aime/shared/threads';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, X } from 'lucide-react';
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
import { ChatQueue } from './chat-queue';
import { ChatWorkspace } from './chat-workspace';
import { ChatMessages } from './chat-messages';
import { ChatErrorCard } from './chat-error-card';
import { ChatRunningTasks } from './chat-running-tasks';
import { useThreadChat } from './use-thread-chat';
import { PersonalChatSettingsProvider } from './personal-chat-settings-provider';

const chatContentClassName = 'mx-auto w-full max-w-3xl px-4 @lg/chat:px-6';

export type ChatPanelProps = {
  threadId?: string | null;
  projectId?: string;
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
    <PersonalChatSettingsProvider
      initialSettings={props.initialSettings}
      projectId={props.projectId}
    >
      <ChatPanelSession
        key={`${props.projectId ?? 'personal'}:${props.threadId ?? 'new'}`}
        {...props}
      />
    </PersonalChatSettingsProvider>
  );
}

function ChatPanelSession({
  threadId,
  projectId,
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
    'flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card',
    className,
  );
  if (activeId)
    return (
      <ExistingChat
        key={`${activeId}:${retry}`}
        threadId={activeId}
        projectId={projectId}
        onThreadUpdated={onThreadUpdated}
        onClose={onClose}
        headerActions={headerActions}
        className={shell}
        onRetry={() => setRetry((value) => value + 1)}
      />
    );
  return (
    <section
      className={shell}
      aria-label={t(projectId ? 'projects.chat' : 'chat.personal')}
    >
      <ChatWorkspace>
        <PanelHeader
          title={t('chat.new')}
          projectId={projectId}
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
          className={chatContentClassName}
          projectId={projectId}
          onSend={async (input) => {
            // Create and accept the first message before navigation or unmount can occur.
            const thread =
              draftThread.current ??
              (await chatApi.create({
                model: input.model,
                reasoningEffort: input.reasoningEffort,
                projectId,
              }));
            draftThread.current = thread;
            const updated = await chatApi.run(thread.id, input);
            setCreated(updated);
            onThreadCreated?.(updated);
          }}
        />
      </ChatWorkspace>
    </section>
  );
}

function PanelHeader({
  title,
  projectId,
  status,
  onClose,
  actions,
  details,
}: {
  title: string;
  projectId?: string;
  status?: ThreadSummary['status'];
  onClose?: () => void;
  actions?: ReactNode;
  details?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 @lg/chat:px-6">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="truncate text-sm font-semibold" title={title}>
            {title}
          </h1>
          {details}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(projectId ? 'projects.chat' : 'chat.personal')}
        </p>
      </div>
      {status && (
        <Badge
          variant={
            status === 'failed' || status === 'tripwire'
              ? 'destructive'
              : 'secondary'
          }
        >
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
  projectId,
  onThreadUpdated,
  onClose,
  headerActions,
  className,
  onRetry,
}: ChatPanelProps & { threadId: string; onRetry: () => void }) {
  const { t } = useTranslation();
  const chat = useThreadChat(threadId, onThreadUpdated);
  const running = isThreadActive(chat.thread?.status);
  const stopping = chat.thread?.stopping ?? false;
  const notifyError = (cause: unknown) => toast.error(t(chatErrorKey(cause)));
  return (
    <section
      className={className}
      aria-label={t(projectId ? 'projects.chat' : 'chat.personal')}
    >
      <ChatWorkspace
        threadId={threadId}
        messages={chat.messages}
        loading={!chat.thread && !chat.error}
        hasEarlier={chat.hasEarlier}
      >
        <PanelHeader
          title={chat.thread?.title || t('chat.new')}
          projectId={projectId}
          status={chat.thread?.status}
          details={
            <ChatRunningTasks
              tasks={chat.backgroundTasks}
              unavailable={!!chat.backgroundTasksError}
              disabled={!chat.connected}
              onStop={(taskId) =>
                chatApi.cancelBackgroundTask(threadId, taskId)
              }
            />
          }
          onClose={onClose}
          actions={headerActions}
        />
        {!!chat.error && (
          <div
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-sm"
          >
            <span className="flex-1">{t(chatErrorKey(chat.error))}</span>
            {!!chat.error && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                {t('chat.reconnect')}
              </Button>
            )}
          </div>
        )}
        <Conversation className="min-h-0" initial="instant" resize="instant">
          <ConversationContent
            className={cn(chatContentClassName, 'gap-6 py-6')}
          >
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
            <ChatMessages
              messages={chat.messages}
              running={running}
              activeMessageId={chat.activeMessageId}
              toolInteractions={chat.toolInteractions}
              onToolResponse={chat.respondToTool}
              disabled={!chat.connected || running || stopping}
            />
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
            {chat.thread?.error && (
              <ChatErrorCard
                error={chat.thread.error}
                disabled={
                  !chat.connected || running || stopping || chat.sending
                }
                onRetry={async () => {
                  await chatApi.retry(threadId);
                }}
              />
            )}
          </ConversationContent>
          <ConversationScrollButton aria-label={t('chat.toLatest')} />
        </Conversation>
        {chat.thread && (
          <ChatComposer
            className={chatContentClassName}
            threadId={threadId}
            disabled={!chat.connected}
            running={running}
            stopping={stopping}
            usage={chat.usage}
            queue={
              <ChatQueue
                thread={chat.thread}
                disabled={!chat.connected}
                waitingForTool={chat.toolInteractions.some(
                  (item) => !item.response,
                )}
              />
            }
            onSend={chat.send}
            onStop={async () => {
              await chatApi.abort(threadId);
            }}
          />
        )}
      </ChatWorkspace>
    </section>
  );
}
