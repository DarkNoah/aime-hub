import { memo, useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  isChatToolGroupPart,
  type ChatTurnSummary,
} from '@aime/shared/chat-turns';
import type { ToolInteraction, ToolResponse } from '@aime/shared/threads';
import { ChatMessage, ChatMessages } from './chat-messages';
import {
  ChatToolGroupRow,
  type LoadedChatToolGroup,
  type LoadChatToolGroup,
} from './chat-tool-group';

type Props = {
  turns: ChatTurnSummary[];
  groupDetails?: Map<string, LoadedChatToolGroup>;
  loadGroupDetails?: LoadChatToolGroup;
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
  groupDetails,
  loadGroupDetails,
  threadId,
  running,
  activeTurnId,
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
          turn={turn}
          groupDetails={groupDetails}
          loadGroupDetails={loadGroupDetails}
          threadId={threadId}
          streaming={running && activeTurnId === turn.id}
          isLatest={turn.id === turns.at(-1)?.id}
          pendingToolCallIds={pendingToolCallIds}
        />
      ))}
      {/* Questions and approvals remain actionable when every tool group is closed. */}
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
  groupDetails,
  loadGroupDetails,
  threadId,
  streaming,
  isLatest,
  pendingToolCallIds,
}: Pick<Props, 'groupDetails' | 'loadGroupDetails' | 'threadId'> & {
  turn: ChatTurnSummary;
  streaming: boolean;
  isLatest: boolean;
  pendingToolCallIds: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const reasoningGroupId = isLatest
    ? turn.assistant?.parts.findLast(
        (part) =>
          isChatToolGroupPart(part) && part.data.reasoningIndex !== undefined,
      )
    : undefined;
  const visibleReasoningId =
    reasoningGroupId && isChatToolGroupPart(reasoningGroupId)
      ? reasoningGroupId.data.id
      : undefined;
  const assistant = useMemo(() => {
    if (!turn.assistant) return null;
    const parts = turn.assistant.parts.filter(
      (part) =>
        (!isToolUIPart(part) || !pendingToolCallIds.has(part.toolCallId)) &&
        (!isChatToolGroupPart(part) ||
          !part.data.reasoningOnly ||
          part.data.id === visibleReasoningId),
    );
    return parts.length ? { ...turn.assistant, parts } : null;
  }, [turn.assistant, pendingToolCallIds, visibleReasoningId]);
  return (
    <div data-chat-turn={turn.id} className="min-w-0 space-y-4">
      {turn.user && (
        <ChatMessage
          message={turn.user}
          threadId={threadId}
          streaming={false}
          showReasoning={false}
        />
      )}
      {assistant && (
        <ChatMessage
          message={assistant}
          threadId={threadId}
          streaming={streaming}
          showReasoning={false}
          hideToolDetails
          elapsedMs={turn.elapsedMs}
          renderToolGroup={(group) => (
            <ChatToolGroupRow
              key={group.id}
              turn={turn}
              group={group}
              detail={groupDetails?.get(`${turn.id}:${group.id}`)}
              loadDetails={loadGroupDetails}
              threadId={threadId}
              pendingToolCallIds={pendingToolCallIds}
              reasoningIndex={
                group.id === visibleReasoningId
                  ? group.reasoningIndex
                  : undefined
              }
            />
          )}
        />
      )}
      {!assistant && streaming && (
        <LoaderCircle
          className="size-3.5 animate-spin text-muted-foreground"
          aria-label={t('chat.running')}
        />
      )}
    </div>
  );
});
