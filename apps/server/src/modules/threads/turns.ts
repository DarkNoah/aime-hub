import { createHash } from 'node:crypto';
import { isToolUIPart, type UIMessage } from 'ai';
import {
  hasChatTurnDetails,
  type ChatTurnSummary,
} from '@aime/shared/chat-turns';

export type ChatTurn = { id: string; messages: UIMessage[] };

/** Input has already been reconciled. Never split a user turn at a storage page. */
export function groupTurns(messages: readonly UIMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.role === 'user' || !turns.length)
      turns.push({ id: message.id, messages: [] });
    turns.at(-1)!.messages.push(message);
  }
  return turns;
}

const revisions = new WeakMap<UIMessage, string>();
function messageRevision(message: UIMessage) {
  let revision = revisions.get(message);
  if (!revision) {
    revision = createHash('sha256')
      .update(JSON.stringify(message))
      .digest('hex');
    revisions.set(message, revision);
  }
  return revision;
}

function timestamp(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || !('createdAt' in metadata))
    return undefined;
  const value = metadata.createdAt;
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    !(value instanceof Date)
  )
    return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

export function summarizeTurn(
  turn: ChatTurn,
  cursor?: string,
): ChatTurnSummary {
  let user: UIMessage | null = null;
  let assistant: UIMessage | null = null;
  let finishedAt: number | undefined;
  const tools = new Set<string>();
  const assets = new Set<string>();
  for (const message of turn.messages) {
    if (message.role === 'user') {
      user = message;
      continue;
    }
    for (const part of message.parts) {
      if (part.type === 'text' && part.text.trim()) {
        assistant = {
          id: message.id,
          role: 'assistant',
          ...(timestamp(message.metadata) !== undefined
            ? {
                metadata: {
                  createdAt: new Date(
                    timestamp(message.metadata)!,
                  ).toISOString(),
                },
              }
            : {}),
          // The overview displays partial text too; the running indicator is separate.
          parts: [{ type: 'text', text: part.text, state: 'done' }],
        };
        finishedAt = timestamp(part.providerMetadata?.mastra);
      }
      if (isToolUIPart(part)) {
        tools.add(part.toolCallId);
        const name =
          part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5);
        if (
          (name === 'image_gen' || name === 'speech') &&
          part.state === 'output-available'
        )
          assets.add(part.toolCallId);
      }
    }
  }
  const startedAt = timestamp(user?.metadata);
  return {
    id: turn.id,
    user,
    assistant,
    hasDetails: hasChatTurnDetails(turn.messages),
    toolCount: tools.size,
    ...(startedAt !== undefined &&
    finishedAt !== undefined &&
    finishedAt >= startedAt
      ? { elapsedMs: finishedAt - startedAt }
      : {}),
    revision: createHash('sha256')
      .update(turn.messages.map(messageRevision).join(':'))
      .digest('hex'),
    assetRevision: [...assets].join(','),
    ...(cursor ? { cursor } : {}),
  };
}
