import { isToolUIPart, type UIMessage, type ToolUIPart } from 'ai';
import { getMessageCompression } from './message-compression.js';
import type { ThreadSnapshot } from './threads.js';
import { isIntelligentUiPart } from './intelligent-ui.js';
import { MCP_AUTHORIZATION_TOOL } from './mcp.js';

export function isCompletedAuthorizationPart(part: UIMessage['parts'][number]) {
  return (
    isToolUIPart(part) &&
    (part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5)) ===
      MCP_AUTHORIZATION_TOOL &&
    (part.state === 'output-available' ||
      part.state === 'output-error' ||
      part.state === 'output-denied')
  );
}

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

/** A consecutive group of tool/reasoning parts; payloads are loaded on expansion. */
export type ChatToolGroup = {
  id: string;
  count: number;
  revision: string;
  state: 'running' | 'completed' | 'failed';
  /** Position of the final reasoning part in this group's flattened detail parts. */
  reasoningIndex?: number;
  /** Allows the overview to omit older thinking without hiding tools or other details. */
  reasoningOnly?: boolean;
};

export type ChatToolGroupPart = {
  type: 'data-tool-group';
  data: ChatToolGroup;
};

export function isChatToolGroupPart(
  part: UIMessage['parts'][number],
): part is ChatToolGroupPart {
  if (part.type !== 'data-tool-group') return false;
  const data = part.data as Partial<ChatToolGroup> | undefined;
  return (
    !!data &&
    typeof data.id === 'string' &&
    typeof data.count === 'number' &&
    typeof data.revision === 'string' &&
    (data.state === 'running' ||
      data.state === 'completed' ||
      data.state === 'failed')
  );
}

export type ChatToolGroupDetail = {
  id: string;
  revision: string;
  messages: UIMessage[];
  page: number;
  hasMore: boolean;
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
          return (
            !isIntelligentUiPart(part) &&
            !isCompletedAskUserPart(part) &&
            !isCompletedAuthorizationPart(part)
          );
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
  /** All assistant text, collapsed tool groups and forced display parts, in order. */
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
