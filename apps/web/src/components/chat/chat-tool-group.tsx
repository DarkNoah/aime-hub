import { memo, useEffect, useRef, useState } from 'react';
import { isToolUIPart } from 'ai';
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LoaderCircle,
  RotateCcwIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type {
  ChatToolGroup,
  ChatToolGroupDetail,
  ChatTurnSummary,
} from '@aime/shared/chat-turns';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ChatMessages } from './chat-messages';
import { chatErrorKey } from './api';

export type LoadedChatToolGroup = ChatToolGroupDetail & {
  /** Summary that initiated this read; the server may already have a newer revision. */
  summaryRevision: string;
};

export type LoadChatToolGroup = (
  turn: ChatTurnSummary,
  group: ChatToolGroup,
  page?: number,
) => Promise<ChatToolGroupDetail>;

function ToolGroupStatusBadge({
  status,
  count,
  icon: Icon,
}: {
  status: 'success' | 'failed' | 'running';
  count: number;
  icon: LucideIcon;
}) {
  const { t } = useTranslation();
  const badge = useRef<HTMLSpanElement>(null);
  const previousCount = useRef(count);

  useEffect(() => {
    const increased = count > previousCount.current;
    previousCount.current = count;
    if (
      !increased ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    const animation = badge.current?.animate(
      [
        { transform: 'translateY(2px) scale(0.94)', opacity: 0.6 },
        { transform: 'translateY(0) scale(1)', opacity: 1 },
      ],
      { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    return () => animation?.cancel();
  }, [count]);

  if (count === 0) return null;

  return (
    <Badge
      ref={badge}
      variant="secondary"
      data-tool-group-status={status}
      className={cn(
        'gap-1 font-normal motion-reduce:transition-none',
        status === 'success'
          ? 'bg-primary/10 text-primary'
          : status === 'failed'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
      )}
    >
      <Icon
        className={cn(
          status === 'running' && 'animate-spin motion-reduce:animate-none',
        )}
        aria-hidden
      />
      {t(`chat.toolGroup.${status}`)}
      <span className="min-w-[1ch] text-center font-medium tabular-nums">
        {count}
      </span>
    </Badge>
  );
}

export const ChatToolGroupRow = memo(function ChatToolGroupRow({
  turn,
  group,
  detail,
  loadDetails,
  threadId,
  pendingToolCallIds,
}: {
  turn: ChatTurnSummary;
  group: ChatToolGroup;
  detail?: LoadedChatToolGroup;
  loadDetails?: LoadChatToolGroup;
  threadId: string;
  pendingToolCallIds: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef({ turn, group });
  const lastRequestAt = useRef(0);
  useEffect(() => {
    latest.current = { turn, group };
  }, [turn, group]);
  const current = detail?.summaryRevision === group.revision;
  const loading = loadingMore || (expanded && !current && !failed);
  const messages = detail?.messages
    .map((message) => ({
      ...message,
      parts: message.parts.filter(
        (part) =>
          !isToolUIPart(part) || !pendingToolCallIds.has(part.toolCallId),
      ),
    }))
    .filter((message) => message.parts.length > 0);

  useEffect(() => {
    if (!expanded || current || failed || !loadDetails) return;
    let disposed = false;
    // Frequent deltas keep the same deadline instead of postponing the read.
    const timer = setTimeout(
      () => {
        lastRequestAt.current = Date.now();
        void loadDetails(latest.current.turn, latest.current.group).catch(
          (cause) => {
            if (!disposed) {
              setFailed(true);
              toast.error(t(chatErrorKey(cause)));
            }
          },
        );
      },
      Math.max(0, 350 - (Date.now() - lastRequestAt.current)),
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [expanded, current, group.revision, failed, loadDetails, t]);

  const loadMore = async () => {
    if (!loadDetails || !detail || loading) return;
    setLoadingMore(true);
    setFailed(false);
    try {
      await loadDetails(turn, group, current ? detail.page + 1 : 0);
    } catch (cause) {
      setFailed(true);
      toast.error(t(chatErrorKey(cause)));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => {
        setExpanded(open);
        setFailed(false);
      }}
      className="group/tool-group @container/tool-group not-prose my-2 min-w-0 rounded-lg border border-border/80"
      data-chat-tool-group={group.id}
    >
      <CollapsibleTrigger className="grid min-h-11 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors duration-150 hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=open]:rounded-b-none data-[state=open]:bg-muted/40 motion-reduce:transition-none @[30rem]/tool-group:grid-cols-[auto_minmax(0,1fr)_auto_auto] @[30rem]/tool-group:gap-x-3">
        <WrenchIcon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1 font-medium leading-5">
          {group.count > 0
            ? t('chat.toolGroup', { count: group.count })
            : t('chat.turns.details')}
        </span>
        {/* Keep status components mounted so a count rising from zero animates. */}
        <span
          className={cn(
            'col-span-2 col-start-1 row-start-2 flex-wrap justify-end gap-1.5 justify-self-end @[30rem]/tool-group:col-span-1 @[30rem]/tool-group:col-start-3 @[30rem]/tool-group:row-start-1',
            group.count > 0 ? 'flex' : 'hidden',
          )}
        >
          <ToolGroupStatusBadge
            status="success"
            count={group.statusCounts.success}
            icon={CheckIcon}
          />
          <ToolGroupStatusBadge
            status="failed"
            count={group.statusCounts.failed}
            icon={CircleAlertIcon}
          />
          <ToolGroupStatusBadge
            status="running"
            count={group.statusCounts.running}
            icon={LoaderCircle}
          />
        </span>
        {group.count === 0 && (
          <Badge
            variant="secondary"
            className={cn(
              'col-span-2 col-start-1 row-start-2 gap-1 justify-self-end font-normal @[30rem]/tool-group:col-span-1 @[30rem]/tool-group:col-start-3 @[30rem]/tool-group:row-start-1',
              group.state === 'failed' && 'bg-destructive/10 text-destructive',
              group.state === 'running' && 'bg-primary/10 text-primary',
            )}
          >
            {group.state === 'running' || loading ? (
              <LoaderCircle
                className="animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : group.state === 'failed' ? (
              <CircleAlertIcon aria-hidden />
            ) : (
              <CheckIcon aria-hidden />
            )}
            {t(
              group.state === 'completed'
                ? 'chat.status.success'
                : group.state === 'failed'
                  ? 'chat.status.failed'
                  : 'chat.status.running',
            )}
          </Badge>
        )}
        <ChevronDownIcon
          className="col-start-3 row-start-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/tool-group:rotate-180 motion-reduce:transition-none @[30rem]/tool-group:col-start-4"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 border-t border-border/70">
        {detail && (
          <ScrollArea
            type="auto"
            viewportProps={{
              className:
                'max-h-[min(24rem,60dvh)] [&>div]:block! focus-visible:ring-inset',
              tabIndex: 0,
              'aria-label': t('chat.turns.details'),
            }}
          >
            <div data-chat-tool-group-detail={group.id} className="px-1 py-1">
              <ChatMessages
                messages={messages ?? []}
                threadId={threadId}
                running={false}
                activeMessageId={null}
                toolGroupsExpanded
                disabled
              />
            </div>
          </ScrollArea>
        )}
        {!detail && !failed && (
          <div role="status" className="space-y-3 px-3 py-3">
            <span className="sr-only">{t('chat.loading')}</span>
            {Array.from(
              { length: Math.min(3, group.count || 1) },
              (_, index) => (
                <div
                  key={index}
                  className="flex h-6 items-center gap-3"
                  aria-hidden
                >
                  <Skeleton className="size-4 shrink-0" />
                  <Skeleton
                    className={index % 2 === 0 ? 'h-3 w-2/5' : 'h-3 w-1/3'}
                  />
                  <Skeleton className="ml-auto h-4 w-14" />
                </div>
              ),
            )}
          </div>
        )}
        {detail && !current && !failed && (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            {t('chat.toolGroup.updating')}
          </p>
        )}
        {failed && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
          >
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleAlertIcon
                className="size-4 shrink-0 text-destructive"
                aria-hidden
              />
              {t('chat.toolGroup.loadFailed')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => {
                if (detail && current) void loadMore();
                else setFailed(false);
              }}
            >
              <RotateCcwIcon className="size-3.5" aria-hidden />
              {t('chat.retry')}
            </Button>
          </div>
        )}
        {detail?.hasMore && !failed && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 w-full rounded-t-none border-t border-border/70 text-muted-foreground hover:text-foreground"
            disabled={loading || !current}
            onClick={() => void loadMore()}
          >
            {loading ? (
              <LoaderCircle
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <ChevronDownIcon className="size-3.5" aria-hidden />
            )}
            {t('chat.toolGroup.loadMore')}
          </Button>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});
