import { isThreadActive } from '@aime/shared/threads';
import { canContinueThread } from '@aime/shared/thread-messages';
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { UIMessage } from 'ai';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatSettings, ThreadSummary } from '@aime/shared/threads';
import { ChatWelcome } from './chat-welcome';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { chatApi, chatErrorKey, ChatApiError } from './api';
import { ChatComposer } from './chat-composer';
import { ChatConversation } from './chat-conversation';
import { ChatQueue } from './chat-queue';
import { ChatWorkspace } from './chat-workspace';
import { LoadingState } from '@/components/loading-state';
import { ChatMessages } from './chat-messages';
import { ChatErrorCard } from './chat-error-card';
import { ChatContinueButton } from './chat-continue-button';
import { ChatRunningTasks } from './chat-running-tasks';
import { useThreadChat } from './use-thread-chat';
import { PersonalChatSettingsProvider } from './personal-chat-settings-provider';
import { ChatWorkspaceMenuContext } from './layout-context';

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
  navigation?: ReactNode;
  draftKey?: number;
};

type WorkspaceSnapshot = {
  threadId?: string;
  messages?: UIMessage[];
  loading?: boolean;
  hasEarlier?: boolean;
};
type SessionProps = ChatPanelProps & {
  onWorkspaceChange: (snapshot: WorkspaceSnapshot) => void;
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
      <ChatPanelWorkspace
        key={
          props.projectId
            ? `project:${props.projectId}`
            : `personal:${props.threadId ?? 'new'}`
        }
        {...props}
      />
    </PersonalChatSettingsProvider>
  );
}

/** The workspace belongs to the project; only the conversation gets a thread key. */
function ChatPanelWorkspace(props: ChatPanelProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({});
  return (
    <section
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card',
        props.className,
      )}
      aria-label={t(props.projectId ? 'projects.chat' : 'chat.personal')}
    >
      <ChatWorkspace {...snapshot} projectId={props.projectId}>
        <ChatPanelSession
          key={props.threadId ?? `new:${props.draftKey ?? 0}`}
          {...props}
          onWorkspaceChange={setSnapshot}
        />
      </ChatWorkspace>
    </section>
  );
}

/** Publish live inspector data without placing its layout inside the keyed chat. */
function WorkspaceMessages({
  onChange,
  ...snapshot
}: WorkspaceSnapshot & {
  onChange: (snapshot: WorkspaceSnapshot) => void;
}) {
  const { threadId, messages, loading, hasEarlier } = snapshot;
  useLayoutEffect(() => {
    onChange({ threadId, messages, loading, hasEarlier });
  }, [onChange, threadId, messages, loading, hasEarlier]);
  return null;
}

function ChatPanelSession({
  threadId,
  projectId,
  onThreadCreated,
  onThreadUpdated,
  onClose,
  headerActions,
  navigation,
  onWorkspaceChange,
}: SessionProps) {
  const { t } = useTranslation();
  const [created, setCreated] = useState<ThreadSummary | null>(null);
  const draftThread = useRef<ThreadSummary | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const activeId = threadId ?? created?.id;
  const [retry, setRetry] = useState(0);
  if (activeId)
    return (
      <ExistingChatSession
        key={`${activeId}:${retry}`}
        threadId={activeId}
        projectId={projectId}
        onThreadUpdated={onThreadUpdated}
        onClose={onClose}
        headerActions={headerActions}
        navigation={navigation}
        onWorkspaceChange={onWorkspaceChange}
        onRetry={() => setRetry((value) => value + 1)}
      />
    );
  return (
    <>
      <WorkspaceMessages onChange={onWorkspaceChange} />
      <PanelHeader
        title={t('chat.new')}
        projectId={projectId}
        onClose={onClose}
        actions={headerActions}
        navigation={navigation}
      />
      <ScrollArea
        className="min-h-0 flex-1"
        viewportProps={{
          className: 'h-full [&>div]:flex! [&>div]:min-h-full [&>div]:min-w-0',
        }}
      >
        <ChatWelcome />
      </ScrollArea>
      <ChatComposer
        className={chatContentClassName}
        projectId={projectId}
        onSend={async (input) => {
          // Create and accept the first message before navigation or unmount can occur.
          const thread =
            draftThread.current ??
            (await chatApi.create({
              model: input.model,
              agentId: input.agentId,
              reasoningEffort: input.reasoningEffort,
              projectId,
            }));
          draftThread.current = thread;
          const updated = await chatApi.run(thread.id, input);
          if (mounted.current) {
            setCreated(updated);
            onThreadCreated?.(updated);
          } else {
            // A completed submission must not navigate away from a newer selection.
            onThreadUpdated?.(updated);
          }
        }}
      />
    </>
  );
}

function PanelHeader({
  title,
  onClose,
  actions,
  details,
  navigation,
}: {
  title: string;
  projectId?: string;
  status?: ThreadSummary['status'];
  onClose?: () => void;
  actions?: ReactNode;
  details?: ReactNode;
  navigation?: ReactNode;
}) {
  const { t } = useTranslation();
  const workspaceMenu = useContext(ChatWorkspaceMenuContext);
  return (
    <header
      data-chat-header
      className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4 @lg/chat:gap-3 @lg/chat:px-6"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="truncate text-sm font-semibold" title={title}>
            {title}
          </h1>
          {details}
        </div>
        {/* <p className="mt-0.5 text-xs text-muted-foreground">
          {t(projectId ? 'projects.chat' : 'chat.personal')}
        </p> */}
      </div>
      {/* {status && (
        <Badge
          className="shrink-0"
          variant={
            status === 'failed' || status === 'tripwire'
              ? 'destructive'
              : 'secondary'
          }
        >
          {t(`chat.status.${status}`)}
        </Badge>
      )} */}
      {actions}
      {navigation}
      {workspaceMenu}
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

function ExistingChatSession(
  props: SessionProps & { threadId: string; onRetry: () => void },
) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(!props.projectId);
  const [error, setError] = useState<ReturnType<typeof chatErrorKey> | null>(
    null,
  );
  useEffect(() => {
    if (!props.projectId) return;
    const controller = new AbortController();
    void chatApi
      .get(props.threadId, controller.signal)
      .then(({ thread }) => {
        if (controller.signal.aborted) return;
        if (thread.projectId !== props.projectId)
          throw new ChatApiError('THREAD_NOT_FOUND');
        setReady(true);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(chatErrorKey(cause));
      });
    return () => controller.abort();
  }, [props.threadId, props.projectId]);
  if (ready) return <ExistingChat {...props} />;
  return (
    <>
      <WorkspaceMessages onChange={props.onWorkspaceChange} loading={!error} />
      <PanelHeader
        title={t('chat.new')}
        projectId={props.projectId}
        actions={props.headerActions}
        navigation={props.navigation}
        onClose={props.onClose}
      />
      {error ? (
        <div role="alert" className="space-y-3 p-6">
          <p>{t(error)}</p>
          <Button variant="outline" onClick={props.onRetry}>
            {t('chat.reconnect')}
          </Button>
        </div>
      ) : (
        <LoadingState className="p-6" />
      )}
    </>
  );
}

function ExistingChat({
  threadId,
  projectId,
  onThreadUpdated,
  onClose,
  headerActions,
  navigation,
  onWorkspaceChange,
  onRetry,
}: SessionProps & { threadId: string; onRetry: () => void }) {
  const { t } = useTranslation();
  const chat = useThreadChat(threadId, onThreadUpdated);
  const running = isThreadActive(chat.thread?.status);
  const [stopping, setStopping] = useState(false);
  const canContinue = canContinueThread(
    chat.messages,
    chat.thread,
    chat.toolInteractions,
  );
  const notifyError = (cause: unknown) => toast.error(t(chatErrorKey(cause)));
  return (
    <>
      <WorkspaceMessages
        onChange={onWorkspaceChange}
        threadId={threadId}
        messages={chat.messages}
        loading={!chat.thread && !chat.error}
        hasEarlier={chat.hasEarlier}
      />
      <PanelHeader
        title={chat.thread?.title || t('chat.new')}
        projectId={projectId}
        status={chat.thread?.status}
        details={
          <ChatRunningTasks
            tasks={chat.backgroundTasks}
            commands={chat.commandSessions}
            unavailable={!!chat.backgroundTasksError}
            disabled={!chat.connected}
            onStop={(taskId) => chatApi.cancelBackgroundTask(threadId, taskId)}
            onCleanup={(sessionId) =>
              chatApi.cleanupCommandSession(threadId, sessionId)
            }
          />
        }
        onClose={onClose}
        actions={headerActions}
        navigation={navigation}
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
      <ChatConversation
        contentClassName={chatContentClassName}
        composer={
          chat.thread && (
            <ChatComposer
              className={chatContentClassName}
              threadId={threadId}
              disabled={!chat.connected}
              running={running}
              stopping={stopping}
              usage={chat.usage}
              goal={chat.goal}
              onClearGoal={chat.clearGoal}
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
                setStopping(true);
                try {
                  await chatApi.abort(threadId);
                } finally {
                  setStopping(false);
                }
              }}
            />
          )
        }
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
        {chat.thread && !chat.messages.length && <ChatWelcome />}
        {running && !chat.activeMessageId && (
          <p
            role="status"
            className="text-sm text-muted-foreground motion-safe:animate-pulse"
          >
            {t('chat.thinking')}
          </p>
        )}
        {canContinue && (
          <ChatContinueButton
            disabled={!chat.connected || stopping || chat.sending}
            onContinue={chat.continueRun}
          />
        )}
        {chat.thread?.error && (
          <ChatErrorCard
            error={chat.thread.error}
            disabled={!chat.connected || running || stopping || chat.sending}
            onRetry={async () => {
              await chatApi.retry(threadId);
            }}
          />
        )}
      </ChatConversation>
    </>
  );
}
