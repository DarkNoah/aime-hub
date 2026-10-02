import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { UIMessage } from 'ai';
import { Braces, Columns2 } from 'lucide-react';
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
  SheetTrigger,
} from '@/components/ui/sheet';
import { ChatRawMessages } from './chat-raw-messages';
import { cn } from '@/lib/utils';

const EMPTY_MESSAGES: UIMessage[] = [];

/** Keep the chat mounted while resizing or switching to the compact drawer. */
export function ChatWorkspace({
  children,
  messages = EMPTY_MESSAGES,
  loading = false,
  hasEarlier = false,
}: {
  children: ReactNode;
  messages?: UIMessage[];
  loading?: boolean;
  hasEarlier?: boolean;
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
  const floating = !compact && chatNarrow;

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

  const content = (
    <ChatRawMessages
      messages={messages}
      loading={loading}
      hasEarlier={hasEarlier}
      onClose={() => {
        panelRef.current?.collapse();
        toggleRef.current?.focus();
      }}
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
              <div className="flex w-12 shrink-0 flex-col items-center border-r py-3">
                <Button
                  ref={toggleRef}
                  variant={expanded ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  aria-label={t('chat.inspector.title')}
                  title={t('chat.inspector.title')}
                  aria-expanded={expanded}
                  aria-controls={contentId}
                  onClick={() => {
                    if (panelRef.current?.isCollapsed())
                      panelRef.current.expand();
                    else panelRef.current?.collapse();
                  }}
                >
                  <Braces className="size-4" aria-hidden="true" />
                </Button>
              </div>
              <aside
                id={contentId}
                aria-label={t('chat.inspector.title')}
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
          <div className="flex w-12 shrink-0 flex-col items-center border-l bg-muted/20 py-3">
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('chat.inspector.title')}
                title={t('chat.inspector.title')}
              >
                <Braces className="size-4" aria-hidden="true" />
              </Button>
            </SheetTrigger>
          </div>
          <SheetContent
            className="w-full max-w-full gap-0 sm:max-w-lg"
            showCloseButton={false}
          >
            <SheetTitle className="sr-only">
              {t('chat.inspector.title')}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {t('chat.inspector.hint')}
            </SheetDescription>
            <ChatRawMessages
              messages={messages}
              loading={loading}
              hasEarlier={hasEarlier}
              onClose={() => setDrawerOpen(false)}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
