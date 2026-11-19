import { memo, useMemo, useState } from 'react';
import {
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  isChatToolGroupPart,
  type ChatTurnSummary,
} from '@aime/shared/chat-turns';
import {
  userQuestionSchema,
  type AskUserAnswer,
  type ToolInteraction,
  type ToolResponse,
} from '@aime/shared/threads';
import { ChatMessage, ChatMessages } from './chat-messages';
import { getToolName } from './tool-renderers/registry';
import { ChatQuestionDrafts, type QuestionDraft } from './question-answer';
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
  thinking?: boolean;
  suspended?: boolean;
  activeTurnId: string | null;
  activeMessageId: string | null;
  toolInteractions: ToolInteraction[];
  onToolResponse?: (id: string, response: ToolResponse) => Promise<void>;
  onQuestionResponses?: (id: string, answers: AskUserAnswer[]) => Promise<void>;
  questionsDisabled?: boolean;
  disabled: boolean;
};

const noInteractions: ToolInteraction[] = [];

export function ChatTurns({
  turns,
  groupDetails,
  loadGroupDetails,
  threadId,
  running,
  thinking = false,
  suspended = false,
  activeTurnId,
  activeMessageId,
  toolInteractions,
  onToolResponse,
  onQuestionResponses,
  disabled,
  questionsDisabled = disabled,
}: Props) {
  const latestTurnId = turns.at(-1)?.id;
  const currentTurnId = activeTurnId ?? latestTurnId;
  const { byTurn, outside } = useMemo(() => {
    const byTurn = new Map<string, ToolInteraction[]>();
    const outside: ToolInteraction[] = [];
    if (!toolInteractions.length) return { byTurn, outside };
    const loaded = new Set(turns.map((turn) => turn.id));
    for (const interaction of toolInteractions) {
      // Old pending records belong to the current run and have no turn ID.
      const id = interaction.turnId ?? latestTurnId;
      if (!id || !loaded.has(id)) {
        outside.push(interaction);
        continue;
      }
      const existing = byTurn.get(id);
      if (existing) existing.push(interaction);
      else byTurn.set(id, [interaction]);
    }
    return { byTurn, outside };
  }, [toolInteractions, turns, latestTurnId]);
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
          thinkingMessageId={
            running && thinking && activeTurnId === turn.id
              ? activeMessageId
              : null
          }
          hideUnreadyQuestions={
            !!onToolResponse &&
            (running || suspended) &&
            (turn.id === latestTurnId || turn.id === activeTurnId)
          }
          toolInteractions={byTurn.get(turn.id) ?? noInteractions}
          suspended={suspended}
          onToolResponse={byTurn.has(turn.id) ? onToolResponse : undefined}
          onQuestionResponses={
            byTurn.has(turn.id) ||
            ((running || suspended) && turn.id === currentTurnId)
              ? onQuestionResponses
              : undefined
          }
          questionsDisabled={questionsDisabled}
          disabled={disabled}
        />
      ))}
      {!!outside.length && (
        <ChatMessages
          messages={[]}
          running={false}
          activeMessageId={null}
          toolInteractions={outside}
          onToolResponse={onToolResponse}
          disabled={disabled}
        />
      )}
    </>
  );
}

const ChatTurnRow = memo(function ChatTurnRow({
  turn,
  groupDetails,
  loadGroupDetails,
  threadId,
  streaming,
  thinkingMessageId,
  hideUnreadyQuestions,
  toolInteractions,
  suspended,
  onToolResponse,
  onQuestionResponses,
  questionsDisabled,
  disabled,
}: Pick<
  Props,
  | 'groupDetails'
  | 'loadGroupDetails'
  | 'threadId'
  | 'toolInteractions'
  | 'suspended'
  | 'onQuestionResponses'
  | 'questionsDisabled'
  | 'disabled'
> & {
  turn: ChatTurnSummary;
  streaming: boolean;
  thinkingMessageId: string | null;
  onToolResponse?: Props['onToolResponse'];
  hideUnreadyQuestions: boolean;
}) {
  const { t } = useTranslation();
  const [questionDrafts] = useState(() => new Map<string, QuestionDraft>());
  const pendingToolCallIds = useMemo(
    () =>
      new Set(
        toolInteractions
          .filter((item) => !item.response)
          .map((item) => item.toolCallId),
      ),
    [toolInteractions],
  );
  const { assistant, questionsByCall } = useMemo(() => {
    const missing = new Set(pendingToolCallIds);
    const parts = (turn.assistant?.parts ?? []).filter((part) => {
      if (isChatToolGroupPart(part)) return !part.data.reasoningOnly;
      if (isToolUIPart(part)) missing.delete(part.toolCallId);
      return true;
    });
    // A suspension may arrive before the corresponding message part, or its
    // tool may be inside a collapsed group. Use the same card until it arrives.
    for (const interaction of toolInteractions) {
      if (!missing.has(interaction.toolCallId)) continue;
      parts.push({
        type: 'dynamic-tool',
        toolName: interaction.toolName,
        toolCallId: interaction.toolCallId,
        state: 'input-available',
        input: interaction.input ?? interaction.suspendPayload,
      });
    }
    const questionsByCall = collectQuestionGroups(
      turn.askUserGroups,
      parts,
      toolInteractions,
    );
    // A single ask is actionable at suspension. A batch also exposes the
    // other declared questions so the user can answer them in any order.
    const visibleParts =
      hideUnreadyQuestions || pendingToolCallIds.size
        ? parts.filter(
            (part) =>
              !isToolUIPart(part) ||
              getToolName(part) !== 'ask_user' ||
              (part.state !== 'input-streaming' &&
                part.state !== 'input-available') ||
              questionsByCall.has(part.toolCallId) ||
              pendingToolCallIds.has(part.toolCallId),
          )
        : parts;
    const message: UIMessage = turn.assistant ?? {
      id: thinkingMessageId ?? turn.id,
      role: 'assistant',
      parts: [],
    };
    return {
      assistant:
        visibleParts.length || thinkingMessageId
          ? { ...message, parts: visibleParts }
          : null,
      questionsByCall,
    };
  }, [
    turn.assistant,
    turn.id,
    turn.askUserGroups,
    pendingToolCallIds,
    thinkingMessageId,
    hideUnreadyQuestions,
    toolInteractions,
  ]);
  return (
    <div data-chat-turn={turn.id} className="min-w-0 space-y-4">
      {turn.user && (
        <ChatMessage
          message={turn.user}
          threadId={threadId}
          streaming={false}
        />
      )}
      {assistant && (
        <ChatQuestionDrafts.Provider value={questionDrafts}>
          <ChatMessage
            message={assistant}
            threadId={threadId}
            streaming={streaming}
            thinking={!!thinkingMessageId}
            hideToolDetails
            elapsedMs={turn.elapsedMs}
            toolInteractions={toolInteractions}
            questionInteractions={suspended ? toolInteractions : noInteractions}
            onToolResponse={onToolResponse}
            questionsByCall={questionsByCall}
            onQuestionResponses={onQuestionResponses}
            questionsDisabled={questionsDisabled}
            disabled={disabled}
            renderToolGroup={(group) => (
              <ChatToolGroupRow
                key={group.id}
                turn={turn}
                group={group}
                detail={groupDetails?.get(`${turn.id}:${group.id}`)}
                loadDetails={loadGroupDetails}
                threadId={threadId}
                pendingToolCallIds={pendingToolCallIds}
              />
            )}
          />
        </ChatQuestionDrafts.Provider>
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

function collectQuestionGroups(
  groups: ChatTurnSummary['askUserGroups'],
  parts: UIMessage['parts'],
  interactions: readonly ToolInteraction[],
) {
  const byCall = new Map<string, (ToolUIPart | DynamicToolUIPart)[]>();
  if (!groups?.length) return byCall;
  const tools = new Map(
    parts.filter(isToolUIPart).map((part) => [part.toolCallId, part]),
  );
  const approvals = new Set(
    interactions
      .filter((item) => item.kind === 'approval')
      .map((item) => item.toolCallId),
  );
  for (const ids of groups) {
    const questions: (ToolUIPart | DynamicToolUIPart)[] = [];
    for (const id of ids) {
      const tool = tools.get(id);
      if (
        !tool ||
        getToolName(tool) !== 'ask_user' ||
        approvals.has(id) ||
        tool.state === 'approval-requested' ||
        tool.state === 'input-streaming' ||
        !userQuestionSchema.safeParse(tool.input).success
      )
        break;
      questions.push(tool);
    }
    if (questions.length < 2 || questions.length !== ids.length) continue;
    for (const id of ids) byCall.set(id, questions);
  }
  return byCall;
}
