import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { isToolUIPart } from 'ai';
import { ChevronDown, ChevronUp, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  hasChatTurnDetails,
  type ChatTurnDetail,
  type ChatTurnSummary,
} from '@aime/shared/chat-turns';
import type { ToolInteraction, ToolResponse } from '@aime/shared/threads';
import {
  isCompletedIntelligentUiPart,
  isIntelligentUiPart,
} from '@aime/shared/intelligent-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChatMessage, ChatMessages } from './chat-messages';
import { chatErrorKey } from './api';
import { useMessagePreview } from './message-preview/context';
import { SubagentBadge } from './subagent-badge';

type Props = {
  turns: ChatTurnSummary[];
  details: Map<string, ChatTurnDetail>;
  loadDetails: (turn: ChatTurnSummary) => Promise<ChatTurnDetail>;
  threadId: string;
  running: boolean;
  activeTurnId: string | null;
  activeMessageId: string | null;
  toolInteractions: ToolInteraction[];
  onToolResponse: (id: string, response: ToolResponse) => Promise<void>;
  disabled: boolean;
};

export function ChatTurns({
  turns,
  details,
  loadDetails,
  threadId,
  running,
  activeTurnId,
  activeMessageId,
  ...props
}: Props) {
  const pendingToolCallIds = useMemo(
    () =>
      new Set(
        props.toolInteractions
          .filter((interaction) => !interaction.response)
          .map((interaction) => interaction.toolCallId),
      ),
    [props.toolInteractions],
  );
  return (
    <>
      {turns.map((turn) => (
        <ChatTurnRow
          key={turn.id}
          loadDetails={loadDetails}
          threadId={threadId}
          running={running}
          activeTurnId={activeTurnId}
          activeMessageId={activeMessageId}
          turn={turn}
          detail={details.get(turn.id)}
          pendingToolCallIds={pendingToolCallIds}
        />
      ))}
      {/* Pending interactions remain actionable even with every detail collapsed. */}
      <ChatMessages
        messages={[]}
        running={false}
        activeMessageId={null}
        toolInteractions={props.toolInteractions}
        onToolResponse={props.onToolResponse}
        disabled={props.disabled}
      />
    </>
  );
}

const ChatTurnRow = memo(function ChatTurnRow({
  turn,
  detail,
  loadDetails,
  threadId,
  running,
  activeTurnId,
  activeMessageId,
  pendingToolCallIds,
}: Pick<
  Props,
  'loadDetails' | 'threadId' | 'running' | 'activeTurnId' | 'activeMessageId'
> & {
  turn: ChatTurnSummary;
  detail?: ChatTurnDetail;
  pendingToolCallIds: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewRequested, setPreviewRequested] = useState(false);
  const openPreview = useMessagePreview();
  const latestTurn = useRef(turn);
  useEffect(() => {
    latestTurn.current = turn;
  }, [turn]);
  const stale = detail?.revision !== turn.revision;
  const streaming = running && activeTurnId === turn.id;
  const hasDetails =
    detail && !stale
      ? hasChatTurnDetails(detail.messages)
      : (turn.hasDetails ??
        (hasChatTurnDetails(turn.assistant ? [turn.assistant] : []) ||
          turn.toolCount > 0));
  const detailsExpanded = expanded && hasDetails;
  const userMessage =
    (detailsExpanded &&
      detail?.messages.find((message) => message.role === 'user')) ||
    turn.user;

  useEffect(() => {
    if ((!detailsExpanded && !previewRequested) || !stale || failed) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      setLoading(true);
      try {
        await loadDetails(latestTurn.current);
        // While open, coalesce revisions instead of fetching on every text delta.
        if (!disposed) timer = setTimeout(() => void refresh(), 750);
      } catch (error) {
        if (!disposed) {
          setFailed(true);
          toast.error(t(chatErrorKey(error)));
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [detailsExpanded, previewRequested, stale, failed, loadDetails, t]);

  return (
    <div data-chat-turn={turn.id} className="min-w-0 space-y-4">
      {userMessage && (
        <ChatMessage
          message={userMessage}
          threadId={threadId}
          streaming={false}
          showReasoning={false}
        />
      )}
      {hasDetails && (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {turn.toolCount > 0 && (
            <Badge variant="secondary">
              {t('chat.toolGroup', { count: turn.toolCount })}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1.5 text-xs"
            aria-expanded={detailsExpanded}
            onClick={() => {
              setExpanded(!detailsExpanded);
              setFailed(false);
            }}
          >
            {loading ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : detailsExpanded ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            {t(detailsExpanded ? 'chat.turns.collapse' : 'chat.turns.details')}
          </Button>
        </div>
      )}
      {detailsExpanded && failed && (
        <Button variant="outline" size="sm" onClick={() => setFailed(false)}>
          {t('chat.retry')}
        </Button>
      )}
      {!detailsExpanded && !!turn.subagents?.length && (
        <div className="flex min-w-0 flex-wrap gap-2">
          {turn.subagents
            .filter((agent) => !pendingToolCallIds.has(agent.toolCallId))
            .map((agent) => (
              <SubagentBadge
                key={agent.toolCallId}
                agent={agent}
                loading={previewing === agent.toolCallId}
                onPreview={
                  openPreview
                    ? () => {
                        setPreviewing(agent.toolCallId);
                        setPreviewRequested(true);
                        setFailed(false);
                        void (
                          detail && !stale
                            ? Promise.resolve(detail)
                            : loadDetails(latestTurn.current)
                        )
                          .then((loaded) => {
                            const tool = loaded.messages
                              .flatMap((message) => message.parts)
                              .find(
                                (part) =>
                                  isToolUIPart(part) &&
                                  part.toolCallId === agent.toolCallId,
                              );
                            if (tool) openPreview(tool);
                            else toast.error(t('chat.preview.empty'));
                          })
                          .catch((cause) => toast.error(t(chatErrorKey(cause))))
                          .finally(() => setPreviewing(null));
                      }
                    : undefined
                }
              />
            ))}
        </div>
      )}
      {detailsExpanded && detail ? (
        <div className="min-w-0 space-y-6" data-chat-turn-detail={turn.id}>
          <ChatMessages
            showAllReasoning
            hideUserMessages
            messages={detail.messages
              .map((message) => ({
                ...message,
                parts: message.parts.filter(
                  // Pending interactions render once in the actionable area,
                  // including ask_user, plans, and generic tool approvals.
                  (part) =>
                    !(
                      isToolUIPart(part) &&
                      pendingToolCallIds.has(part.toolCallId)
                    ) &&
                    (!isIntelligentUiPart(part) ||
                      isCompletedIntelligentUiPart(part)),
                ),
              }))
              .filter((message) => message.parts.length)}
            threadId={threadId}
            running={streaming}
            activeMessageId={activeMessageId}
            disabled
          />
        </div>
      ) : (
        <>
          {turn.assistant && (
            <ChatMessage
              message={turn.assistant}
              threadId={threadId}
              streaming={streaming}
              showReasoning={false}
              elapsedMs={turn.elapsedMs}
            />
          )}
          {!turn.assistant && streaming && (
            <LoaderCircle
              className="size-3.5 animate-spin text-muted-foreground"
              aria-label={t('chat.running')}
            />
          )}
        </>
      )}
    </div>
  );
});
