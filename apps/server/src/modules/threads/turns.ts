import { createHash } from 'node:crypto';
import { isToolUIPart, type UIMessage } from 'ai';
import {
  isSubagentTool,
  type ChatSubagentSummary,
  type ChatTurnSummary,
} from '@aime/shared/chat-turns';
import { projectTurn, type TurnProjectionOptions } from './turn-projection.js';
import { messageRevision } from './turn-revision.js';
export type { TurnProjectionOptions } from './turn-projection.js';

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
  options: TurnProjectionOptions = {},
): ChatTurnSummary {
  let user: UIMessage | null = null;
  let assistantMessage: UIMessage | null = null;
  const projection = projectTurn(turn.messages, {
    ...options,
    turnId: turn.id,
    cursor,
  });
  let finishedAt: number | undefined;
  const tools = new Set<string>();
  const assets = new Set<string>();
  const subagents = new Map<string, ChatSubagentSummary>();
  for (const message of turn.messages) {
    if (message.role === 'user') {
      user = message;
      continue;
    }
    for (const part of message.parts) {
      if (message.parts.length) assistantMessage ??= message;
      if (part.type === 'text' && part.text.trim())
        finishedAt = timestamp(part.providerMetadata?.mastra);
      if (isToolUIPart(part)) {
        tools.add(part.toolCallId);
        const name =
          part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5);
        if (isSubagentTool(name))
          subagents.set(part.toolCallId, {
            toolCallId: part.toolCallId,
            toolName: name,
            state: part.state,
          });
        if (
          (name === 'image_gen' || name === 'speech') &&
          part.state === 'output-available'
        )
          assets.add(part.toolCallId);
      }
    }
  }
  const createdAt = timestamp(assistantMessage?.metadata);
  const assistant: UIMessage | null =
    assistantMessage && projection.parts.length
      ? {
          id: assistantMessage.id,
          role: 'assistant',
          ...(createdAt !== undefined
            ? { metadata: { createdAt: new Date(createdAt).toISOString() } }
            : {}),
          parts: projection.parts,
        }
      : null;
  const startedAt = timestamp(user?.metadata);
  return {
    id: turn.id,
    user,
    assistant,
    hasDetails: projection.groups.length > 0,
    toolCount: tools.size,
    ...(subagents.size ? { subagents: [...subagents.values()] } : {}),
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

/** Locate only the hidden parts represented by one lightweight group. */
export function getTurnToolGroup(
  turn: ChatTurn,
  groupId: string,
  options: TurnProjectionOptions = {},
) {
  return projectTurn(turn.messages, {
    ...options,
    turnId: turn.id,
  }).groups.find((group) => group.summary.id === groupId);
}
