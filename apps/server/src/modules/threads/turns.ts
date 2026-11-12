import { createHash } from 'node:crypto';
import { isToolUIPart, type UIMessage } from 'ai';
import { isCompletedIntelligentUiPart } from '@aime/shared/intelligent-ui';
import {
  hasChatTurnDetails,
  isCompletedAskUserPart,
  isCompletedAuthorizationPart,
  isSubagentTool,
  type ChatSubagentSummary,
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

function imageGenerationOverview(part: UIMessage['parts'][number]) {
  if (
    !isToolUIPart(part) ||
    (part.type === 'dynamic-tool' ? part.toolName : part.type.slice(5)) !==
      'image_gen' ||
    part.state !== 'output-available'
  )
    return;
  let output = part.output;
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output) as unknown;
    } catch {
      return;
    }
  }
  if (!output || typeof output !== 'object') return;
  const result = output as Record<string, unknown>;
  if (result.ok === false || result.isError === true) return;
  const path =
    typeof result.file_path === 'string' ? result.file_path : undefined;
  const asset = result.asset as { threadId?: unknown } | undefined;
  const threadId =
    typeof asset?.threadId === 'string' ? asset.threadId : undefined;
  const content = Array.isArray(result.content)
    ? result.content.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && item.type === 'image',
      )
    : [];
  if (!content.length) return;
  return {
    ...(part.type === 'dynamic-tool'
      ? { type: part.type, toolName: part.toolName }
      : { type: part.type }),
    toolCallId: part.toolCallId,
    state: 'output-available' as const,
    input: {},
    output: {
      file_path: path,
      // Saved images load on demand; prompts and reference-image bytes stay in details.
      content: content.map((image) =>
        path && threadId
          ? {
              type: 'image',
              mimeType: image.mimeType,
              url: `/api/threads/${encodeURIComponent(threadId)}/files/raw?${new URLSearchParams({ path })}`,
            }
          : image,
      ),
    },
  };
}

export function summarizeTurn(
  turn: ChatTurn,
  cursor?: string,
): ChatTurnSummary {
  let user: UIMessage | null = null;
  let assistantMessage: UIMessage | null = null;
  let finalText: UIMessage['parts'][number] | undefined;
  const overview: UIMessage['parts'] = [];
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
      const image = imageGenerationOverview(part);
      if (image) {
        assistantMessage ??= message;
        overview.push(image);
      }
      if (
        isCompletedIntelligentUiPart(part) ||
        isCompletedAskUserPart(part) ||
        isCompletedAuthorizationPart(part)
      ) {
        assistantMessage ??= message;
        overview.push(part);
      }
      if (part.type === 'text' && part.text.trim()) {
        assistantMessage = message;
        // The overview displays partial text too; the running indicator is separate.
        finalText = { type: 'text', text: part.text, state: 'done' };
        overview.push(finalText);
        finishedAt = timestamp(part.providerMetadata?.mastra);
      }
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
  const assistant: UIMessage | null = assistantMessage
    ? {
        id: assistantMessage.id,
        role: 'assistant',
        ...(createdAt !== undefined
          ? { metadata: { createdAt: new Date(createdAt).toISOString() } }
          : {}),
        // Keep generated images and panels in order while omitting intermediate text.
        parts: overview.filter(
          (part) => part.type !== 'text' || part === finalText,
        ),
      }
    : null;
  const startedAt = timestamp(user?.metadata);
  return {
    id: turn.id,
    user,
    assistant,
    hasDetails: hasChatTurnDetails(turn.messages),
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
