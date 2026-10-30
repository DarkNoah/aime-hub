import { isToolUIPart, type UIMessage, type ToolUIPart } from 'ai';
import { getMessageCompression } from './message-compression.js';
import type { ThreadSnapshot } from './threads.js';
import { isIntelligentUiPart } from './intelligent-ui.js';

export function isSubagentTool(
  name: string | undefined,
): name is `agent-${string}` {
  return !!name?.startsWith('agent-') && name.length > 'agent-'.length;
}

export type ChatSubagentSummary = {
  toolCallId: string;
  toolName: string;
  state: ToolUIPart['state'];
};

/** Answered questions remain visible when the rest of a turn is collapsed. */
export function isCompletedAskUserPart(part: UIMessage['parts'][number]) {
  return (
    isToolUIPart(part) &&
    (part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5)) ===
      'ask_user' &&
    (part.state === 'output-available' || part.state === 'output-denied')
  );
}

/** Details must add visible content beyond the final text already in the overview. */
export function hasChatTurnDetails(messages: readonly UIMessage[]) {
  let textCount = 0;
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some((part) => {
        if (part.type === 'text') return !!part.text.trim() && ++textCount > 1;
        if (part.type === 'reasoning') return !!part.text.trim();
        if (isToolUIPart(part))
          return !isIntelligentUiPart(part) && !isCompletedAskUserPart(part);
        if (part.type === 'file') return part.mediaType.startsWith('image/');
        if (part.type === 'data-background-task-completed') {
          const data = part.data;
          return !!(
            data &&
            typeof data === 'object' &&
            'toolName' in data &&
            typeof data.toolName === 'string' &&
            data.toolName.trim()
          );
        }
        return getMessageCompression(part) !== null;
      }),
  );
}

/** Display data only. Complete parts live in the independently loaded detail. */
export type ChatTurnSummary = {
  id: string;
  user: UIMessage | null;
  /** Final text, completed HTML panels, and answered questions in part order. */
  assistant: UIMessage | null;
  /** Whether details add visible content beyond the final assistant text. */
  hasDetails?: boolean;
  toolCount: number;
  /** Lightweight badges; full delegation inputs and results stay in turn details. */
  subagents?: ChatSubagentSummary[];
  elapsedMs?: number;
  revision: string;
  assetRevision: string;
  /** Opaque storage boundary, scoped to this thread. Live turns may omit it. */
  cursor?: string;
};

export type ChatTurnPage = {
  turns: ChatTurnSummary[];
  cursor: string | null;
  hasMore: boolean;
};

export type ChatTurnDetail = {
  id: string;
  revision: string;
  messages: UIMessage[];
};

export type ChatTurnSnapshot = Omit<
  ThreadSnapshot<UIMessage>,
  'messages' | 'removedMessageIds'
> & {
  turns: ChatTurnSummary[];
  removedTurnIds?: string[];
  activeTurnId: string | null;
  canContinue: boolean;
  /** Present on the initial snapshot and on reconnect, never on an update. */
  history?: Pick<ChatTurnPage, 'cursor' | 'hasMore'>;
};
