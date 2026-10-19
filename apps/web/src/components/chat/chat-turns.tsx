import { memo, useEffect, useRef, useState } from 'react';
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
}: Pick<
  Props,
  'loadDetails' | 'threadId' | 'running' | 'activeTurnId' | 'activeMessageId'
> & {
  turn: ChatTurnSummary;
  detail?: ChatTurnDetail;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
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
    if (!detailsExpanded || !stale || failed) return;
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
  }, [detailsExpanded, stale, failed, loadDetails, t]);

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
      {detailsExpanded && detail ? (
        <div className="min-w-0 space-y-6" data-chat-turn-detail={turn.id}>
          <ChatMessages
            showAllReasoning
            hideUserMessages
            messages={detail.messages
              .map((message) => ({
                ...message,
                parts: message.parts.filter(
                  // Pending panels remain in the actionable interaction area.
                  (part) =>
                    !isIntelligentUiPart(part) ||
                    isCompletedIntelligentUiPart(part),
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
