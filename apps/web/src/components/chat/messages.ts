import {
  isToolUIPart,
  type UIMessage,
  type ToolUIPart,
  type DynamicToolUIPart,
} from 'ai';
import {
  getMessageCompressions,
  getMessageCompression,
  type MessageCompression,
} from './message-compression.js';
import { getToolName, isSpecialTool } from './tool-renderers/registry.js';
import { isSubagentTool } from '@aime/shared/chat-turns';
import { lastTextDate, messageDate } from './message-time.js';
import {
  mergeThreadMessages,
  threadMessageSourceIds,
} from '@aime/shared/thread-messages';

export type ChatMessagePart =
  | { type: 'part'; part: UIMessage['parts'][number]; index: number }
  | {
      type: 'compression';
      compression: MessageCompression;
      part: UIMessage['parts'][number];
    }
  | { type: 'tools'; tools: (ToolUIPart | DynamicToolUIPart)[]; id: string };

function isGroupingMetadata(part: UIMessage['parts'][number]) {
  return (
    part.type.startsWith('data-') ||
    part.type.startsWith('step-') ||
    part.type == 'reasoning'
  );
}

export function groupMessageParts(
  message: UIMessage,
  interactiveToolIds?: Set<string>,
  compressions = getMessageCompressions([message]),
): ChatMessagePart[] {
  const groups: ChatMessagePart[] = [];
  let toolGroup: Extract<ChatMessagePart, { type: 'tools' }> | undefined;
  for (const [index, part] of message.parts.entries()) {
    if (
      isToolUIPart(part) &&
      !isSpecialTool(getToolName(part)) &&
      !isSubagentTool(getToolName(part)) &&
      !interactiveToolIds?.has(part.toolCallId)
    ) {
      if (toolGroup) toolGroup.tools.push(part);
      else {
        toolGroup = {
          type: 'tools',
          tools: [part],
          id: `${message.id}:${part.toolCallId}`,
        };
        groups.push(toolGroup);
      }
    } else {
      // Preserve event rendering without breaking the surrounding tool group.
      if (!isGroupingMetadata(part)) toolGroup = undefined;
      if (getMessageCompression(part)) {
        const compression = compressions.get(part);
        if (compression)
          groups.push({ type: 'compression', compression, part });
      } else groups.push({ type: 'part', part, index });
    }
  }
  return groups;
}

export function groupChatMessages(
  messages: UIMessage[],
  interactiveToolIds?: Set<string>,
) {
  const compressions = getMessageCompressions(messages);
  const rows: {
    message: UIMessage;
    sourceIds: string[];
    elapsedMs?: number;
  }[] = [];
  let previousUserMessageTime: number | undefined;
  let lastAssistantTextRow: (typeof rows)[number] | undefined;
  for (const message of mergeThreadMessages([], messages)) {
    const hasAssistantText =
      message.role === 'assistant' &&
      message.parts.some((part) => part.type === 'text' && part.text.trim());
    let elapsedMs: number | undefined;
    if (message.role === 'user') {
      // An undated user message must not fall back to an older user turn.
      previousUserMessageTime = messageDate(message.metadata)?.getTime();
      lastAssistantTextRow = undefined;
    } else if (hasAssistantText) {
      // Only the last assistant text in each user turn gets a duration.
      // Tool, reasoning and task events never replace that text endpoint.
      if (lastAssistantTextRow) lastAssistantTextRow.elapsedMs = undefined;
      const time = lastTextDate(message)?.getTime();
      if (
        time !== undefined &&
        previousUserMessageTime !== undefined &&
        time >= previousUserMessageTime
      )
        elapsedMs = time - previousUserMessageTime;
    }
    const previous = rows.at(-1);
    const lastPart = previous?.message.parts.reduce<
      UIMessage['parts'][number] | undefined
    >((last, part) => (isGroupingMetadata(part) ? last : part), undefined);
    const firstPart = message.parts.find((part) => !isGroupingMetadata(part));
    if (
      previous?.message.role === 'assistant' &&
      message.role === 'assistant' &&
      lastPart &&
      isToolUIPart(lastPart) &&
      message.parts.length > 0 &&
      (!firstPart || isToolUIPart(firstPart))
    ) {
      previous.message = {
        ...previous.message,
        parts: [...previous.message.parts, ...message.parts],
      };
      previous.sourceIds.push(...threadMessageSourceIds(message));
      // Tool grouping keeps the first message's metadata; use the last text's
      // own timestamp for its footer instead of the start of the tool group.
      if (hasAssistantText) previous.elapsedMs = elapsedMs;
    } else
      rows.push({
        message,
        sourceIds: threadMessageSourceIds(message),
        elapsedMs,
      });
    if (hasAssistantText) lastAssistantTextRow = rows.at(-1);
  }
  return rows.map((row) => ({
    ...row,
    parts: groupMessageParts(row.message, interactiveToolIds, compressions),
  }));
}

export function mergeMessages(
  current: UIMessage[],
  incoming: UIMessage[],
  older = false,
  removedMessageIds: string[] = [],
) {
  return older
    ? mergeThreadMessages(incoming, current, removedMessageIds)
    : mergeThreadMessages(current, incoming, removedMessageIds);
}
