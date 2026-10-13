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
import {
  Braces,
  ChevronDown,
  Columns2,
  Files,
  Images,
  ScanText,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePanelRef } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import {
  ChatWorkspaceMenuContext,
  FloatingChatContext,
} from './layout-context';
import './chat-floating.css';
import { AssetAttachmentProvider } from '@/components/generated-assets/attachment-context';
import {
  readWorkspaceLayout,
  saveWorkspaceLayout,
} from './workspace-layout-storage';

const AssetPanel = lazy(
  () => import('@/components/generated-assets/asset-panel'),
);

const FileManager = lazy(
  () => import('@/components/file-manager/file-manager'),
);

const EMPTY_MESSAGES: UIMessage[] = [];

const workspaceViews = [
  { view: 'files', label: 'files.title', icon: Files },
  { view: 'assets', label: 'assets.title', icon: Images },
  { view: 'messages', label: 'chat.inspector.title', icon: Braces },
  { view: 'preview', label: 'chat.preview.title', icon: ScanText },
] as const;

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
  const [layout, setLayout] = useState(readWorkspaceLayout);
  const [compact, setCompact] = useState(true);
  const [expanded, setExpanded] = useState(layout.mode !== 'collapsed');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState<'files' | 'messages' | 'preview' | 'assets'>(
    'files',
  );
  // Only completed generation changes refresh the gallery, not every text delta.
  const assetRevision = messages
    .flatMap((message) =>
      message.parts.flatMap((part) =>
        (part.type === 'tool-image_gen' ||
          part.type === 'tool-speech' ||
          (part.type === 'dynamic-tool' &&
            (part.toolName === 'image_gen' || part.toolName === 'speech'))) &&
        'state' in part &&
        part.state === 'output-available'
          ? [part.toolCallId]
          : [],
      ),
    )
    .join(',');
  const [selection, setSelection] = useState<MessagePreviewSelection | null>(
    null,
  );
  useEffect(() => saveWorkspaceLayout(layout), [layout]);
  const expandInspector = useCallback(() => {
    if (!panelRef.current?.isCollapsed()) return;
    setLayout((previous) => ({ ...previous, mode: 'docked' }));
    panelRef.current.resize(`${layout.inspectorSize}%`);
  }, [layout.inspectorSize, panelRef]);
  const openPreview = useCallback(
    (part: PreviewPart) => {
      const next = selectMessagePart(messages, part);
      if (!next) return;
      setSelection(next);
      setView('preview');
      if (compact) setDrawerOpen(true);
      else expandInspector();
    },
    [messages, compact, expandInspector],
  );
  const floating = !compact && layout.mode === 'floating';
  // Apply explicit exits only after React has removed the floating size constraint.
  useLayoutEffect(() => {
    if (compact || floating || !pendingLayoutAction.current) return;
    const action = pendingLayoutAction.current;
    pendingLayoutAction.current = null;
    if (action === 'restore')
      panelRef.current?.resize(`${layout.inspectorSize}%`);
    else panelRef.current?.collapse();
  }, [compact, floating, layout.inspectorSize, panelRef]);
  const files = useFileManager(
    threadId,
    view === 'files' && (compact ? drawerOpen : expanded),
  );
  const { revealFile, revealDirectory } = files;
  const openWorkspaceFile = useCallback(
    (path: string, kind: 'file' | 'directory' = 'file') => {
      setView('files');
      if (compact) setDrawerOpen(true);
      else expandInspector();
      if (kind === 'directory') revealDirectory(path);
      else revealFile(path);
    },
    [compact, expandInspector, revealDirectory, revealFile],
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
    } else panelRef.current?.collapse();
    setLayout((previous) => ({ ...previous, mode: 'collapsed' }));
  };
  const close = () => {
    if (compact) setDrawerOpen(false);
    else {
      collapseInspector();
      toggleRef.current?.focus();
    }
  };
  const workspaceMenu = compact ? (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={toggleRef}
          variant="ghost"
          size="icon-sm"
          aria-label={t('chat.workspace.menu')}
          title={t('chat.workspace.menu')}
        >
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (drawerOpen) event.preventDefault();
        }}
      >
        {workspaceViews.map(({ view: nextView, label, icon: Icon }) => (
          <DropdownMenuItem
            key={nextView}
            onSelect={() => {
              setView(nextView);
              setDrawerOpen(true);
            }}
          >
            <Icon className="size-4" aria-hidden="true" />
            {t(label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  const title = t(
    view === 'files'
      ? 'files.title'
      : view === 'assets'
        ? 'assets.title'
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
    ) : view === 'assets' ? (
      <Suspense
        fallback={
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {t('files.loading')}
          </p>
        }
      >
        <AssetPanel
          key={threadId ?? 'new'}
          threadId={threadId}
          revision={assetRevision}
          onClose={close}
        />
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
    <AssetAttachmentProvider>
      <MessagePreviewContext.Provider value={openPreview}>
        <WorkspaceFileContext.Provider
          value={files.available ? openWorkspaceFile : null}
        >
          <div
            ref={containerRef}
            className="relative flex min-h-0 min-w-0 flex-1"
          >
            <ResizablePanelGroup
              orientation="horizontal"
              disabled={floating}
              onLayoutChanged={(
                sizes,
                { isUserInteraction, requestedLayout },
              ) => {
                if (compact || floating || !isUserInteraction) return;
                const inspector = panelRef.current;
                if (!inspector) return;
                if (inspector.isCollapsed()) {
                  setLayout((previous) => ({ ...previous, mode: 'collapsed' }));
                } else {
                  const inspectorSize = (requestedLayout ?? sizes)[
                    `${contentId}-inspector`
                  ];
                  setLayout((previous) =>
                    previous.mode === 'floating' ||
                    !inspectorSize ||
                    inspectorSize >= 100
                      ? previous
                      : { mode: 'docked', inspectorSize },
                  );
                }
              }}
            >
              <ResizablePanel
                id={`${contentId}-chat`}
                minSize={0}
                // Keep the inspector full-width even if an in-flight drag writes another layout.
                maxSize={floating ? '0%' : '100%'}
                onResize={(size) => {
                  // Compact mode temporarily removes the inspector; it must not reset the saved mode.
                  if (
                    !compact &&
                    !floating &&
                    !pendingLayoutAction.current &&
                    (containerRef.current?.clientWidth ?? 0) >= 760 &&
                    size.inPixels < 360
                  ) {
                    setLayout((previous) => ({
                      ...previous,
                      mode: 'floating',
                    }));
                  }
                }}
                className="h-full min-h-0"
                style={{ overflow: 'visible' }}
              >
                <FloatingWindow
                  active={floating}
                  boundaryRef={containerRef}
                  storageKey="chat-floating-window:v1"
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
                        // Save a width that leaves docked chat usable on the current screen.
                        const width = containerRef.current?.clientWidth ?? 760;
                        pendingLayoutAction.current = 'restore';
                        setLayout((previous) => ({
                          ...previous,
                          mode: 'docked',
                          inspectorSize: Math.min(
                            previous.inspectorSize,
                            ((width - 361) / width) * 100,
                          ),
                        }));
                      }}
                    >
                      <Columns2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  }
                >
                  <FloatingChatContext.Provider value={floating}>
                    <ChatWorkspaceMenuContext.Provider value={workspaceMenu}>
                      {children}
                    </ChatWorkspaceMenuContext.Provider>
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
                    defaultSize={
                      layout.mode === 'collapsed'
                        ? 48
                        : `${layout.inspectorSize}%`
                    }
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
                          else expandInspector();
                        }}
                      >
                        <Files className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant={
                          expanded && view === 'assets' ? 'secondary' : 'ghost'
                        }
                        size="icon-sm"
                        aria-label={t('assets.title')}
                        title={t('assets.title')}
                        aria-expanded={expanded && view === 'assets'}
                        aria-controls={contentId}
                        onClick={() => {
                          setView('assets');
                          if (expanded && view === 'assets')
                            collapseInspector();
                          else expandInspector();
                        }}
                      >
                        <Images className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant={
                          expanded && view === 'messages'
                            ? 'secondary'
                            : 'ghost'
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
                          else expandInspector();
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
                          if (expanded && view === 'preview')
                            collapseInspector();
                          else expandInspector();
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
                <SheetContent
                  className="w-full max-w-full gap-0 sm:max-w-lg"
                  showCloseButton={false}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    toggleRef.current?.focus();
                  }}
                >
                  <SheetTitle className="sr-only">{title}</SheetTitle>
                  <SheetDescription className="sr-only">
                    {t(
                      view === 'files'
                        ? 'files.previewHint'
                        : view === 'assets'
                          ? 'assets.emptyHint'
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
    </AssetAttachmentProvider>
  );
}
