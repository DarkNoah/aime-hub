import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { UIMessage } from 'ai';
import { Braces, Columns2, Files } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { useFileManager } from '@/components/file-manager/use-file-manager';

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
  const contentId = useId();
  const [compact, setCompact] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatNarrow, setChatNarrow] = useState(false);
  const [view, setView] = useState<'files' | 'messages'>('files');
  const floating = !compact && chatNarrow;
  const files = useFileManager(
    threadId,
    view === 'files' && (compact ? drawerOpen : expanded),
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

  const close = () => {
    if (compact) setDrawerOpen(false);
    else panelRef.current?.collapse();
    toggleRef.current?.focus();
  };
  const title = t(view === 'files' ? 'files.title' : 'chat.inspector.title');
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
    ) : (
      <ChatRawMessages
        messages={messages}
        loading={loading}
        hasEarlier={hasEarlier}
        onClose={close}
      />
    );

  return (
    <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel
          id={`${contentId}-chat`}
          minSize={0}
          onResize={(size) => setChatNarrow(size.inPixels < 360)}
          className="h-full min-h-0"
          style={{ overflow: 'visible' }}
        >
          <div
            data-chat-floating={floating || undefined}
            className={cn(
              '@container/chat flex min-h-0 min-w-0 flex-col overflow-hidden bg-card',
              floating
                ? 'absolute bottom-4 left-4 z-20 h-[min(36rem,calc(100%-2rem))] w-[26rem] max-w-[calc(100%-2rem)] rounded-xl shadow-md ring-1 ring-border'
                : 'h-full w-full',
            )}
          >
            {floating && (
              <div className="flex h-10 shrink-0 items-center justify-between border-b bg-muted/40 px-3">
                <span className="text-xs font-medium">
                  {t('chat.inspector.floating')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => panelRef.current?.resize('38%')}
                >
                  <Columns2 className="size-3.5" aria-hidden="true" />
                  {t('chat.inspector.restore')}
                </Button>
              </div>
            )}
            {children}
          </div>
        </ResizablePanel>
        {!compact && (
          <>
            <ResizableHandle aria-label={t('chat.inspector.resize')} />
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
                  variant={expanded && view === 'files' ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  aria-label={t('files.title')}
                  title={t('files.title')}
                  aria-expanded={expanded && view === 'files'}
                  aria-controls={contentId}
                  onClick={() => {
                    setView('files');
                    if (expanded && view === 'files')
                      panelRef.current?.collapse();
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
                      panelRef.current?.collapse();
                    else panelRef.current?.expand();
                  }}
                >
                  <Braces className="size-4" aria-hidden="true" />
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
          </div>
          <SheetContent
            className="w-full max-w-full gap-0 sm:max-w-lg"
            showCloseButton={false}
          >
            <SheetTitle className="sr-only">{title}</SheetTitle>
            <SheetDescription className="sr-only">
              {t(
                view === 'files' ? 'files.previewHint' : 'chat.inspector.hint',
              )}
            </SheetDescription>
            {content}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
