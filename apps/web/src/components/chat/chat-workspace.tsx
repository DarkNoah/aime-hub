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
import type { FileScope } from '@aime/shared/files';
import { useLocation } from '@tanstack/react-router';
import './workspace-navigation';
import {
  CircleDot,
  Braces,
  ChevronDown,
  Columns2,
  Files,
  Globe2,
  Images,
  ScanText,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
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
import type { PreviewPart } from './message-preview/selection';
import { useMessagePreviewController } from './message-preview/use-message-preview';
import { cn } from '@/lib/utils';
import { useFileManager } from '@/components/file-manager/use-file-manager';
import { WorkspaceFileContext } from '@/components/file-manager/context';
import { WorkspaceDragContext } from '@/components/file-manager/drag-context';
import { filesApi, fileErrorKey } from '@/components/file-manager/api';
import { FloatingWindow } from '@/components/floating-window';
import { BrowserStatusIcon } from '@/components/browser/status-icon';
import { usePluginRightSidebar } from '@/features/plugins/use-right-sidebar';
import { PluginRightSidebar } from '@/features/plugins/right-sidebar';
import {
  ChatWorkspaceMenuContext,
  ChatWorkspacePanelContext,
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
const IssueBoard = lazy(() => import('@/components/issues/board'));
const BrowserPanel = lazy(() => import('@/components/browser/panel'));

const EMPTY_MESSAGES: UIMessage[] = [];
type CloseExtraPanel = (afterClose?: () => void) => void;

function WorkspaceExtraPanel({
  render,
  onClose,
}: {
  render: (onClose: CloseExtraPanel) => ReactNode;
  onClose: CloseExtraPanel;
}) {
  return render(onClose);
}

const workspaceViews = [
  { view: 'issues', label: 'issues.heading', icon: CircleDot },
  { view: 'files', label: 'files.title', icon: Files },
  { view: 'assets', label: 'assets.title', icon: Images },
  { view: 'messages', label: 'chat.inspector.title', icon: Braces },
  { view: 'preview', label: 'chat.preview.title', icon: ScanText },
  { view: 'browser', label: 'browser.title', icon: Globe2 },
] as const;
type WorkspaceView =
  | (typeof workspaceViews)[number]['view']
  | `plugin:${string}:${string}`
  | 'extra';

/** Keep the chat mounted while resizing or switching to the compact drawer. */
export function ChatWorkspace({
  children,
  messages = EMPTY_MESSAGES,
  loading = false,
  hasEarlier = false,
  assetRevision: turnAssetRevision,
  threadId,
  projectId,
  defaultFileScope = 'thread',
  extraPanel,
}: {
  children: ReactNode;
  messages?: UIMessage[];
  loading?: boolean;
  hasEarlier?: boolean;
  assetRevision?: string;
  threadId?: string;
  projectId?: string;
  defaultFileScope?: FileScope;
  extraPanel?: {
    title: string;
    icon: LucideIcon;
    render: (onClose: CloseExtraPanel) => ReactNode;
  };
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const afterDrawerClose = useRef<(() => void) | null>(null);
  const panelRef = usePanelRef();
  const pendingLayoutAction = useRef<'restore' | 'collapse' | null>(null);
  const contentId = useId();
  const [layout, setLayout] = useState(readWorkspaceLayout);
  const [compact, setCompact] = useState(true);
  const [expanded, setExpanded] = useState(layout.mode !== 'collapsed');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState<WorkspaceView>('files');
  const requestedPanel = useLocation({
    select: (location) => location.state.chatWorkspace,
  });
  const handledPanelRequest = useRef<string | null>(null);
  const pluginSidebars = usePluginRightSidebar();
  const activePlugin = pluginSidebars.find((entry) => entry.view === view);
  const activeExtra = view === 'extra' ? extraPanel : undefined;
  // Drop the selection immediately when disabled or access is revoked. Keep chat mounted.
  if (view.startsWith('plugin:') && !activePlugin) setView('files');
  if (view === 'extra' && !extraPanel) setView('files');
  // Only completed generation changes refresh the gallery, not every text delta.
  const assetRevision =
    turnAssetRevision ??
    messages
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
  const {
    selection,
    part: previewPart,
    open: selectPreview,
  } = useMessagePreviewController(messages);
  useEffect(() => saveWorkspaceLayout(layout), [layout]);
  const expandInspector = useCallback(() => {
    if (!panelRef.current?.isCollapsed()) return;
    setLayout((previous) => ({ ...previous, mode: 'docked' }));
    panelRef.current.resize(`${layout.inspectorSize}%`);
  }, [layout.inspectorSize, panelRef]);
  const openExtraPanel = useCallback(() => {
    setView('extra');
    if (compact) setDrawerOpen(true);
    else expandInspector();
  }, [compact, expandInspector]);
  useEffect(() => {
    if (
      !requestedPanel ||
      requestedPanel.threadId !== threadId ||
      handledPanelRequest.current === requestedPanel.requestId
    )
      return;
    // Wait for the existing responsive layout to mount its panel or drawer.
    const measuredCompact = (containerRef.current?.clientWidth ?? 0) < 760;
    if (measuredCompact !== compact) return;
    const frame = requestAnimationFrame(() => {
      handledPanelRequest.current = requestedPanel.requestId;
      setView(requestedPanel.view);
      if (compact) setDrawerOpen(true);
      else expandInspector();
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedPanel, threadId, compact, expandInspector]);
  const openPreview = useCallback(
    (part: PreviewPart) => {
      if (!selectPreview(part)) return;
      setView('preview');
      if (compact) setDrawerOpen(true);
      else expandInspector();
    },
    [selectPreview, compact, expandInspector],
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
  const [fileScope, setFileScope] = useState<FileScope>(
    projectId ? 'thread' : defaultFileScope,
  );
  const filesVisible = view === 'files' && (compact ? drawerOpen : expanded);
  const files = useFileManager(
    threadId,
    filesVisible && fileScope === 'thread',
  );
  const sharedFiles = useFileManager(
    projectId ? undefined : threadId,
    !projectId && filesVisible && fileScope === 'shared',
    'shared',
  );
  const { revealFile, revealDirectory } = files;
  const {
    revealFile: revealSharedFile,
    revealDirectory: revealSharedDirectory,
  } = sharedFiles;
  const fileNavigation = useRef<AbortController | null>(null);
  useEffect(() => () => fileNavigation.current?.abort(), [threadId]);
  const openWorkspaceFile = useCallback(
    (path: string) => {
      if (!threadId) return;
      fileNavigation.current?.abort();
      const controller = new AbortController();
      fileNavigation.current = controller;
      void filesApi
        .resolve(threadId, path, controller.signal)
        .then((target) => {
          if (controller.signal.aborted) return;
          setFileScope(target.scope);
          setView('files');
          if (compact) setDrawerOpen(true);
          else expandInspector();
          const reveal =
            target.scope === 'shared'
              ? target.kind === 'directory'
                ? revealSharedDirectory
                : revealSharedFile
              : target.kind === 'directory'
                ? revealDirectory
                : revealFile;
          reveal(target.path);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) toast.error(t(fileErrorKey(error)));
        });
    },
    [
      threadId,
      compact,
      expandInspector,
      revealDirectory,
      revealFile,
      revealSharedDirectory,
      revealSharedFile,
      t,
    ],
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
  const closeExtraPanel: CloseExtraPanel = (afterClose) => {
    if (compact && drawerOpen) {
      afterDrawerClose.current = afterClose ?? null;
      setDrawerOpen(false);
    } else {
      close();
      afterClose?.();
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
        {extraPanel && (
          <DropdownMenuItem onSelect={openExtraPanel}>
            <extraPanel.icon className="size-4" aria-hidden="true" />
            {extraPanel.title}
          </DropdownMenuItem>
        )}
        {workspaceViews.map(({ view: nextView, label, icon: Icon }) => (
          <DropdownMenuItem
            key={nextView}
            onSelect={() => {
              setView(nextView);
              setDrawerOpen(true);
            }}
          >
            {nextView === 'browser' ? (
              <BrowserStatusIcon threadId={threadId} />
            ) : (
              <Icon className="size-4" aria-hidden="true" />
            )}
            {t(label)}
          </DropdownMenuItem>
        ))}
        {pluginSidebars.map((entry) => (
          <DropdownMenuItem
            key={entry.view}
            onSelect={() => {
              setView(entry.view);
              setDrawerOpen(true);
            }}
          >
            <entry.Icon className="size-4" aria-hidden="true" />
            {entry.title}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  const title =
    activeExtra?.title ??
    activePlugin?.title ??
    t(
      view === 'issues'
        ? 'issues.heading'
        : view === 'files'
          ? 'files.title'
          : view === 'assets'
            ? 'assets.title'
            : view === 'messages'
              ? 'chat.inspector.title'
              : view === 'browser'
                ? 'browser.title'
                : 'chat.preview.title',
    );
  const content = activeExtra ? (
    <WorkspaceExtraPanel
      render={activeExtra.render}
      onClose={closeExtraPanel}
    />
  ) : activePlugin ? (
    <PluginRightSidebar
      key={activePlugin.view}
      entry={activePlugin}
      threadId={threadId}
      projectId={projectId}
      onClose={close}
    />
  ) : view === 'issues' ? (
    <Suspense
      fallback={
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {t('chat.loading')}
        </p>
      }
    >
      <IssueBoard
        compact
        projectId={projectId}
        threadId={threadId}
        onClose={close}
      />
    </Suspense>
  ) : view === 'files' ? (
    <Suspense
      fallback={
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {t('files.loading')}
        </p>
      }
    >
      <FileManager
        state={files}
        sharedState={projectId ? undefined : sharedFiles}
        scope={fileScope}
        onScopeChange={setFileScope}
        onClose={close}
      />
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
  ) : view === 'browser' ? (
    <Suspense
      fallback={
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {t('browser.loading')}
        </p>
      }
    >
      <BrowserPanel threadId={threadId} onClose={close} />
    </Suspense>
  ) : view === 'preview' ? (
    <ChatMessagePreview
      key={JSON.stringify(selection)}
      threadId={threadId}
      part={previewPart}
      onClose={close}
    />
  ) : (
    <ChatRawMessages
      key={threadId ?? 'new'}
      threadId={threadId}
      messages={messages}
      loading={loading}
      hasEarlier={hasEarlier}
      onClose={close}
    />
  );

  const workspace = (
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
                      <ChatWorkspacePanelContext.Provider
                        value={extraPanel ? openExtraPanel : null}
                      >
                        {children}
                      </ChatWorkspacePanelContext.Provider>
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
                      {extraPanel && (
                        <Button
                          variant={
                            expanded && view === 'extra' ? 'secondary' : 'ghost'
                          }
                          size="icon-sm"
                          aria-label={extraPanel.title}
                          title={extraPanel.title}
                          aria-expanded={expanded && view === 'extra'}
                          aria-controls={contentId}
                          onClick={() => {
                            if (expanded && view === 'extra')
                              collapseInspector();
                            else openExtraPanel();
                          }}
                        >
                          <extraPanel.icon
                            className="size-4"
                            aria-hidden="true"
                          />
                        </Button>
                      )}
                      <Button
                        variant={
                          expanded && view === 'issues' ? 'secondary' : 'ghost'
                        }
                        size="icon-sm"
                        aria-label={t('issues.heading')}
                        title={t('issues.heading')}
                        aria-expanded={expanded && view === 'issues'}
                        aria-controls={contentId}
                        onClick={() => {
                          setView('issues');
                          if (expanded && view === 'issues')
                            collapseInspector();
                          else expandInspector();
                        }}
                      >
                        <CircleDot className="size-4" aria-hidden="true" />
                      </Button>
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
                      <Button
                        variant={
                          expanded && view === 'browser' ? 'secondary' : 'ghost'
                        }
                        size="icon-sm"
                        aria-label={t('browser.title')}
                        title={t('browser.title')}
                        aria-expanded={expanded && view === 'browser'}
                        aria-controls={contentId}
                        onClick={() => {
                          setView('browser');
                          if (expanded && view === 'browser')
                            collapseInspector();
                          else expandInspector();
                        }}
                      >
                        <BrowserStatusIcon threadId={threadId} />
                      </Button>
                      {pluginSidebars.map((entry) => (
                        <Button
                          key={entry.view}
                          variant={
                            expanded && view === entry.view
                              ? 'secondary'
                              : 'ghost'
                          }
                          size="icon-sm"
                          aria-label={entry.title}
                          title={entry.title}
                          aria-expanded={expanded && view === entry.view}
                          aria-controls={contentId}
                          onClick={() => {
                            setView(entry.view);
                            if (expanded && view === entry.view)
                              collapseInspector();
                            else expandInspector();
                          }}
                        >
                          <entry.Icon className="size-4" aria-hidden="true" />
                        </Button>
                      ))}
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
                    const afterClose = afterDrawerClose.current;
                    afterDrawerClose.current = null;
                    if (afterClose) afterClose();
                    else toggleRef.current?.focus();
                  }}
                >
                  <SheetTitle className="sr-only">{title}</SheetTitle>
                  <SheetDescription className="sr-only">
                    {activeExtra || activePlugin
                      ? title
                      : t(
                          view === 'issues'
                            ? 'issues.detailHint'
                            : view === 'files'
                              ? 'files.previewHint'
                              : view === 'assets'
                                ? 'assets.emptyHint'
                                : view === 'messages'
                                  ? 'chat.inspector.hint'
                                  : view === 'browser'
                                    ? 'browser.watchHint'
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
  return (
    <WorkspaceDragContext.Provider
      value={`${contentId}:${projectId ?? threadId ?? 'new'}`}
    >
      {workspace}
    </WorkspaceDragContext.Provider>
  );
}
