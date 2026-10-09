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
import {
  mergeThreadMessage,
  sortThreadMessages,
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
  const rows: { message: UIMessage; sourceIds: string[] }[] = [];
  for (const message of messages) {
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
      previous.sourceIds.push(message.id);
    } else rows.push({ message, sourceIds: [message.id] });
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
  const messages = new Map<string, UIMessage>();
  const removed = new Set(removedMessageIds);
  for (const message of older
    ? [...incoming, ...current]
    : [...current, ...incoming]) {
    if (removed.has(message.id)) continue;
    const previous = messages.get(message.id);
    messages.set(
      message.id,
      previous ? mergeThreadMessage(previous, message) : message,
    );
  }
  return sortThreadMessages([...messages.values()]);
}
