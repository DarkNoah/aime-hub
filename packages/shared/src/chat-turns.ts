import { isToolUIPart, type UIMessage } from 'ai';
import { getMessageCompression } from './message-compression.js';
import type { ThreadSnapshot } from './threads.js';

/** Details must add visible content beyond the final text already in the overview. */
export function hasChatTurnDetails(messages: readonly UIMessage[]) {
  let textCount = 0;
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some((part) => {
        if (part.type === 'text') return !!part.text.trim() && ++textCount > 1;
        if (part.type === 'reasoning') return !!part.text.trim();
        if (isToolUIPart(part)) return true;
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
  assistant: UIMessage | null;
  /** Whether details add visible content beyond the final assistant text. */
  hasDetails?: boolean;
  toolCount: number;
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
