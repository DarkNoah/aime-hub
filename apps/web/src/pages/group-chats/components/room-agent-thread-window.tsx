import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import type { GroupChatAgent } from '@aime/shared/group-chats';
import { ChatThreadView } from '@/components/chat/chat-thread-view';
import { useThreadChat } from '@/components/chat/use-thread-chat';
import { chatErrorKey } from '@/components/chat/api';
import { FloatingChatContext } from '@/components/chat/layout-context';
import { MessagePreviewContext } from '@/components/chat/message-preview/context';
import { ChatMessagePreview } from '@/components/chat/message-preview/chat-message-preview';
import { ThreadFilePreview } from '@/components/chat/message-preview/thread-file-preview';
import { useMessagePreviewController } from '@/components/chat/message-preview/use-message-preview';
import { WorkspaceFileContext } from '@/components/file-manager/context';
import { AssetAttachmentContext } from '@/components/generated-assets/context';
import { FloatingWindow } from '@/components/floating-window';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogPortal,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export default function RoomAgentThreadWindow({
  agent,
  projectId,
  onClose,
}: {
  agent: GroupChatAgent;
  projectId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // The viewport exists before the window's layout effect measures its bounds.
  const boundary = useRef<HTMLElement>(document.documentElement);
  const [compact, setCompact] = useState(
    () => window.matchMedia('(max-width: 759px)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(max-width: 759px)');
    const change = () => setCompact(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const title = t('groupChat.agentThreadTitle', { name: agent.name });
  return (
    <Dialog
      open
      modal={compact}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPortal>
        <div className="pointer-events-none fixed inset-0 z-50">
          <FloatingWindow
            active={!compact}
            boundaryRef={boundary}
            storageKey="group-chat-agent-window:v1"
            title={title}
            moveLabel={t('chat.inspector.moveWindow')}
            resizeLabel={(direction) =>
              t(`chat.inspector.resizeWindow.${direction}`)
            }
            className="pointer-events-auto"
            data-agent-thread-window
            actions={
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6"
                onClick={onClose}
                aria-label={t('common.close')}
              >
                <X className="size-3.5" />
              </Button>
            }
          >
            <ThreadSession
              key={agent.threadId}
              agent={agent}
              projectId={projectId}
              compact={compact}
              onClose={onClose}
            />
          </FloatingWindow>
        </div>
      </DialogPortal>
    </Dialog>
  );
}

function ThreadSession({
  agent,
  projectId,
  compact,
  onClose,
}: {
  agent: GroupChatAgent;
  projectId?: string;
  compact: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const chat = useThreadChat(agent.threadId, undefined, {
    receiveSpeech: false,
  });
  const preview = useMessagePreviewController(chat.messages);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [opener] = useState(() => document.activeElement);
  const toolPreview = useRef<HTMLDivElement>(null);
  const filePreview = useRef<HTMLDivElement>(null);
  const previewOpen = !!filePath || !!preview.selection;
  useEffect(() => {
    const panel = filePath
      ? filePreview.current
      : preview.selection
        ? toolPreview.current
        : null;
    if (!panel) return;
    const previous = document.activeElement;
    panel.querySelector('button')?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [filePath, preview.selection]);
  return (
    <DialogPrimitive.Content
      className="flex min-h-0 flex-1 flex-col outline-none"
      onInteractOutside={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const target =
          opener instanceof HTMLElement && opener.isConnected
            ? opener
            : document.querySelector<HTMLElement>('[data-group-chat-members]');
        target?.focus({ preventScroll: true });
      }}
      onEscapeKeyDown={(event) => {
        if (!previewOpen) return;
        event.preventDefault();
        if (filePath) setFilePath(null);
        else preview.close();
      }}
    >
      <header className="space-y-2 border-b px-3 py-3">
        <div className="flex items-center gap-2">
          <DialogTitle
            className={cn(
              'min-w-0 flex-1 truncate text-sm leading-normal',
              !compact && 'sr-only',
            )}
          >
            {t('groupChat.agentThreadTitle', { name: agent.name })}
          </DialogTitle>
          <Badge variant="outline">{t('groupChat.agentThreadReadOnly')}</Badge>
          <Badge
            variant={
              chat.thread?.status === 'failed' ? 'destructive' : 'secondary'
            }
          >
            {chat.thread
              ? t(`chat.status.${chat.thread.status}`)
              : t('chat.loading')}
          </Badge>
          <Button asChild variant="ghost" size="icon-sm" className="ml-auto">
            <Link
              {...(projectId
                ? {
                    to: '/projects/$projectId/threads/$threadId',
                    params: { projectId, threadId: agent.threadId },
                  }
                : {
                    to: '/threads/$threadId',
                    params: { threadId: agent.threadId },
                  })}
              title={t('groupChat.openFullThread')}
              aria-label={t('groupChat.openFullThread')}
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
          {compact && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
        <DialogDescription className="text-xs leading-relaxed">
          {t('groupChat.agentThreadHint')}
        </DialogDescription>
      </header>
      <AssetAttachmentContext.Provider value={null}>
        <WorkspaceFileContext.Provider value={setFilePath}>
          <MessagePreviewContext.Provider value={preview.open}>
            <FloatingChatContext.Provider value>
              <div className="relative min-h-0 flex-1">
                <div
                  className={cn(
                    'flex h-full min-h-0 flex-col',
                    previewOpen && chat.thread && 'invisible',
                  )}
                  inert={previewOpen && !!chat.thread}
                >
                  <ChatThreadView
                    threadId={agent.threadId}
                    chat={chat}
                    readOnly
                    emptyState={
                      <p className="py-8 text-center text-sm text-muted-foreground">
                        {t('groupChat.agentThreadEmpty')}
                      </p>
                    }
                  >
                    {!!chat.error && (
                      <p role="alert" className="text-sm text-destructive">
                        {t(chatErrorKey(chat.error))}
                      </p>
                    )}
                    {chat.thread?.error && (
                      <p
                        role="alert"
                        className="break-words text-sm text-destructive"
                      >
                        {chat.thread.error}
                      </p>
                    )}
                  </ChatThreadView>
                </div>
                {chat.thread && preview.selection && (
                  <div
                    ref={toolPreview}
                    className={cn(
                      'absolute inset-0 bg-card',
                      filePath && 'invisible',
                    )}
                    inert={!!filePath}
                  >
                    <ChatMessagePreview
                      key={JSON.stringify(preview.selection)}
                      part={preview.part}
                      threadId={agent.threadId}
                      onClose={preview.close}
                      back
                    />
                  </div>
                )}
                {chat.thread && filePath && (
                  <div
                    ref={filePreview}
                    className="absolute inset-0 flex min-h-0 flex-col bg-card"
                  >
                    <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setFilePath(null)}
                      >
                        <ArrowLeft className="size-4" aria-hidden="true" />
                        {t(
                          preview.selection
                            ? 'chat.preview.backToTool'
                            : 'chat.preview.backToMessages',
                        )}
                      </Button>
                      <span
                        className="min-w-0 truncate text-xs text-muted-foreground"
                        title={filePath}
                      >
                        {filePath.split('/').pop()}
                      </span>
                    </header>
                    <div className="min-h-0 flex-1 overflow-hidden">
                      <ThreadFilePreview
                        key={filePath}
                        threadId={agent.threadId}
                        path={filePath}
                      />
                    </div>
                  </div>
                )}
              </div>
            </FloatingChatContext.Provider>
          </MessagePreviewContext.Provider>
        </WorkspaceFileContext.Provider>
      </AssetAttachmentContext.Provider>
    </DialogPrimitive.Content>
  );
}
