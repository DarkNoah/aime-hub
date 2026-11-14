import { memo, useEffect, useRef, useState } from 'react';
import { isToolUIPart } from 'ai';
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LoaderCircle,
  RotateCcwIcon,
  WrenchIcon,
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

export const ChatToolGroupRow = memo(function ChatToolGroupRow({
  turn,
  group,
  detail,
  loadDetails,
  threadId,
  pendingToolCallIds,
  reasoningIndex,
}: {
  turn: ChatTurnSummary;
  group: ChatToolGroup;
  detail?: LoadedChatToolGroup;
  loadDetails?: LoadChatToolGroup;
  threadId: string;
  pendingToolCallIds: ReadonlySet<string>;
  reasoningIndex?: number;
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
  let partIndex = 0;
  const messages = detail?.messages
    .map((message) => ({
      ...message,
      parts: message.parts.filter((part) => {
        const index = partIndex++;
        return part.type === 'reasoning'
          ? index === reasoningIndex
          : !isToolUIPart(part) || !pendingToolCallIds.has(part.toolCallId);
      }),
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
      className="group/tool-group not-prose my-2 min-w-0 rounded-lg border border-border/80"
      data-chat-tool-group={group.id}
    >
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors duration-150 hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=open]:rounded-b-none data-[state=open]:bg-muted/40 motion-reduce:transition-none sm:gap-3">
        {group.reasoningOnly ? (
          <BrainIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        ) : (
          <WrenchIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1 font-medium leading-5">
          {group.count > 0
            ? t('chat.toolGroup', { count: group.count })
            : t(group.reasoningOnly ? 'chat.reasoning' : 'chat.turns.details')}
        </span>
        <Badge
          variant="secondary"
          className={cn(
            'gap-1 font-normal',
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
        <ChevronDownIcon
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/tool-group:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 border-t border-border/70">
        {detail && (
          <ScrollArea
            type="auto"
            viewportProps={{
              className: cn(
                '[&>div]:block! focus-visible:ring-inset',
                !group.reasoningOnly && 'max-h-[min(24rem,60dvh)]',
              ),
              tabIndex: group.reasoningOnly ? undefined : 0,
              'aria-label': t('chat.turns.details'),
            }}
          >
            <div
              data-chat-tool-group-detail={group.id}
              className={group.reasoningOnly ? 'px-3 py-3' : 'px-1 py-1'}
            >
              <ChatMessages
                messages={messages ?? []}
                threadId={threadId}
                running={false}
                activeMessageId={null}
                showAllReasoning
                hideReasoningTrigger={group.reasoningOnly}
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
