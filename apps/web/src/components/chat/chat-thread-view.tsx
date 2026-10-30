import type { ReactNode } from 'react';
import { isThreadActive } from '@aime/shared/threads';
import { useTranslation } from 'react-i18next';
import { ChatConversation } from './chat-conversation';
import { ChatHistoryLoader } from './chat-history-loader';
import { ChatTurns } from './chat-turns';
import { ChatWelcome } from './chat-welcome';
import type { useThreadChat } from './use-thread-chat';

export const chatContentClassName =
  'mx-auto w-full max-w-3xl px-4 @lg/chat:px-6';

/** Message history and live turns, independent of workspace panels and input controls. */
export function ChatThreadView({
  threadId,
  chat,
  readOnly = false,
  disabled = false,
  emptyState,
  composer = null,
  children,
}: {
  threadId: string;
  chat: ReturnType<typeof useThreadChat>;
  readOnly?: boolean;
  disabled?: boolean;
  emptyState?: ReactNode;
  composer?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const running = isThreadActive(chat.thread?.status);
  return (
    <ChatConversation
      contentClassName={chatContentClassName}
      composer={composer}
    >
      <ChatHistoryLoader
        hasEarlier={chat.hasEarlier}
        loading={chat.loadingHistory}
        loadEarlier={chat.loadEarlier}
        firstTurnId={chat.turns[0]?.id}
      />
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
      <ChatTurns
        turns={chat.turns}
        details={chat.details}
        loadDetails={chat.loadDetails}
        activeTurnId={chat.activeTurnId}
        threadId={threadId}
        running={running}
        activeMessageId={chat.activeMessageId}
        toolInteractions={readOnly ? [] : chat.toolInteractions}
        onToolResponse={chat.respondToTool}
        disabled={readOnly || disabled || !chat.connected || running}
      />
      {chat.thread && !chat.turns.length && (emptyState ?? <ChatWelcome />)}
      {running && !chat.activeMessageId && (
        <p
          role="status"
          className="text-sm text-muted-foreground motion-safe:animate-pulse"
        >
          {t('chat.thinking')}
        </p>
      )}
      {children}
    </ChatConversation>
  );
}
