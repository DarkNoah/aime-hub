import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { UIMessage } from 'ai';
import { Braces, Columns2, Files, ScanText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePanelRef } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { ChatRawMessages } from './chat-raw-messages';
import { ChatMessagePreview } from './message-preview/chat-message-preview';
import { MessagePreviewContext } from './message-preview/context';
import {
  resolveMessagePart,
  selectMessagePart,
  type MessagePreviewSelection,
  type PreviewPart,
} from './message-preview/selection';
import { cn } from '@/lib/utils';
import { useFileManager } from '@/components/file-manager/use-file-manager';
import { WorkspaceFileContext } from '@/components/file-manager/context';
import { FloatingWindow } from '@/components/floating-window';
import { FloatingChatContext } from './layout-context';
import './chat-floating.css';

const FileManager = lazy(
  () => import('@/components/file-manager/file-manager'),
);

const EMPTY_MESSAGES: UIMessage[] = [];

/** Keep the chat mounted while resizing or switching to the compact drawer. */
export function ChatWorkspace({
  children,
  messages = EMPTY_MESSAGES,
  loading = false,
  hasEarlier = false,
  threadId,
}: {
  children: ReactNode;
  messages?: UIMessage[];
  loading?: boolean;
  hasEarlier?: boolean;
  threadId?: string;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = usePanelRef();
  const pendingLayoutAction = useRef<'restore' | 'collapse' | null>(null);
  const contentId = useId();
  const [compact, setCompact] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatNarrow, setChatNarrow] = useState(false);
  const [view, setView] = useState<'files' | 'messages' | 'preview'>('files');
  const [selection, setSelection] = useState<MessagePreviewSelection | null>(
    null,
  );
  const openPreview = useCallback(
    (part: PreviewPart) => {
      const next = selectMessagePart(messages, part);
      if (!next) return;
      setSelection(next);
      setView('preview');
      if (compact) setDrawerOpen(true);
      else panelRef.current?.expand();
    },
    [messages, compact, panelRef],
  );
  const floating = !compact && chatNarrow;
  // Apply explicit exits only after React has removed the floating size constraint.
  useLayoutEffect(() => {
    if (floating || !pendingLayoutAction.current) return;
    const action = pendingLayoutAction.current;
    pendingLayoutAction.current = null;
    if (action === 'restore') panelRef.current?.resize('38%');
    else panelRef.current?.collapse();
  }, [floating, panelRef]);
  const files = useFileManager(
    threadId,
    view === 'files' && (compact ? drawerOpen : expanded),
  );
  const { revealFile } = files;
  const openWorkspaceFile = useCallback(
    (path: string) => {
      setView('files');
      if (compact) setDrawerOpen(true);
      else panelRef.current?.expand();
      revealFile(path);
    },
    [compact, panelRef, revealFile],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const nextCompact = entry.contentRect.width < 760;
      setCompact(nextCompact);
      if (!nextCompact) setDrawerOpen(false);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const collapseInspector = () => {
    if (floating) {
      pendingLayoutAction.current = 'collapse';
      setChatNarrow(false);
    } else panelRef.current?.collapse();
  };
  const close = () => {
    if (compact) setDrawerOpen(false);
    else collapseInspector();
    toggleRef.current?.focus();
  };
  const title = t(
    view === 'files'
      ? 'files.title'
      : view === 'messages'
        ? 'chat.inspector.title'
        : 'chat.preview.title',
  );
  const content =
    view === 'files' ? (
      <Suspense
        fallback={
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {t('files.loading')}
          </p>
        }
      >
        <FileManager state={files} onClose={close} />
      </Suspense>
    ) : view === 'preview' ? (
      <ChatMessagePreview
        key={JSON.stringify(selection)}
        part={resolveMessagePart(messages, selection)}
        onClose={close}
      />
    ) : (
      <ChatRawMessages
        messages={messages}
        loading={loading}
        hasEarlier={hasEarlier}
        onClose={close}
      />
    );

  return (
    <MessagePreviewContext.Provider value={openPreview}>
      <WorkspaceFileContext.Provider
        value={files.available ? openWorkspaceFile : null}
      >
        <div
          ref={containerRef}
          className="relative flex min-h-0 min-w-0 flex-1"
        >
          <ResizablePanelGroup orientation="horizontal" disabled={floating}>
            <ResizablePanel
              id={`${contentId}-chat`}
              minSize={0}
              // Keep the inspector full-width even if an in-flight drag writes another layout.
              maxSize={floating ? '0%' : '100%'}
              onResize={(size) => setChatNarrow(size.inPixels < 360)}
              className="h-full min-h-0"
              style={{ overflow: 'visible' }}
            >
              <FloatingWindow
                active={floating}
                boundaryRef={containerRef}
                title={t('chat.inspector.floating')}
                moveLabel={t('chat.inspector.moveWindow')}
                resizeLabel={(direction) =>
                  t(`chat.inspector.resizeWindow.${direction}`)
                }
                data-chat-floating={floating || undefined}
                className="@container/chat"
                actions={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('chat.inspector.restore')}
                    title={t('chat.inspector.restore')}
                    onClick={() => {
                      pendingLayoutAction.current = 'restore';
                      setChatNarrow(false);
                    }}
                  >
                    <Columns2 className="size-3.5" aria-hidden="true" />
                  </Button>
                }
              >
                <FloatingChatContext.Provider value={floating}>
                  {children}
                </FloatingChatContext.Provider>
              </FloatingWindow>
            </ResizablePanel>
            {!compact && (
              <>
                <ResizableHandle
                  aria-label={t('chat.inspector.resize')}
                  disabled={floating}
                  className={cn(floating && 'invisible w-0')}
                />
                <ResizablePanel
                  id={`${contentId}-inspector`}
                  panelRef={panelRef}
                  defaultSize="38%"
                  minSize={320}
                  maxSize="100%"
                  collapsible
                  collapsedSize={48}
                  onResize={(size) => setExpanded(size.inPixels > 49)}
                  className="flex h-full min-h-0 bg-muted/20"
                >
                  <div className="flex w-12 shrink-0 flex-col items-center gap-2 border-r py-3">
                    <Button
                      ref={toggleRef}
                      variant={
                        expanded && view === 'files' ? 'secondary' : 'ghost'
                      }
                      size="icon-sm"
                      aria-label={t('files.title')}
                      title={t('files.title')}
                      aria-expanded={expanded && view === 'files'}
                      aria-controls={contentId}
                      onClick={() => {
                        setView('files');
                        if (expanded && view === 'files') collapseInspector();
                        else panelRef.current?.expand();
                      }}
                    >
                      <Files className="size-4" aria-hidden="true" />
                    </Button>
                    <Button
                      variant={
                        expanded && view === 'messages' ? 'secondary' : 'ghost'
                      }
                      size="icon-sm"
                      aria-label={t('chat.inspector.title')}
                      title={t('chat.inspector.title')}
                      aria-expanded={expanded && view === 'messages'}
                      aria-controls={contentId}
                      onClick={() => {
                        setView('messages');
                        if (expanded && view === 'messages')
                          collapseInspector();
                        else panelRef.current?.expand();
                      }}
                    >
                      <Braces className="size-4" aria-hidden="true" />
                    </Button>
                    <Button
                      variant={
                        expanded && view === 'preview' ? 'secondary' : 'ghost'
                      }
                      size="icon-sm"
                      aria-label={t('chat.preview.title')}
                      title={t('chat.preview.title')}
                      aria-expanded={expanded && view === 'preview'}
                      aria-controls={contentId}
                      onClick={() => {
                        setView('preview');
                        if (expanded && view === 'preview') collapseInspector();
                        else panelRef.current?.expand();
                      }}
                    >
                      <ScanText className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <aside
                    id={contentId}
                    aria-label={title}
                    hidden={!expanded}
                    className="min-h-0 min-w-0 flex-1"
                  >
                    {expanded && content}
                  </aside>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
          {compact && (
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <div className="flex w-12 shrink-0 flex-col items-center gap-2 border-l bg-muted/20 py-3">
                <Button
                  ref={toggleRef}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('files.title')}
                  title={t('files.title')}
                  onClick={() => {
                    setView('files');
                    setDrawerOpen(true);
                  }}
                >
                  <Files className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('chat.inspector.title')}
                  title={t('chat.inspector.title')}
                  onClick={() => {
                    setView('messages');
                    setDrawerOpen(true);
                  }}
                >
                  <Braces className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('chat.preview.title')}
                  title={t('chat.preview.title')}
                  onClick={() => {
                    setView('preview');
                    setDrawerOpen(true);
                  }}
                >
                  <ScanText className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <SheetContent
                className="w-full max-w-full gap-0 sm:max-w-lg"
                showCloseButton={false}
              >
                <SheetTitle className="sr-only">{title}</SheetTitle>
                <SheetDescription className="sr-only">
                  {t(
                    view === 'files'
                      ? 'files.previewHint'
                      : view === 'messages'
                        ? 'chat.inspector.hint'
                        : 'chat.preview.hint',
                  )}
                </SheetDescription>
                {content}
              </SheetContent>
            </Sheet>
          )}
        </div>
      </WorkspaceFileContext.Provider>
    </MessagePreviewContext.Provider>
  );
}
