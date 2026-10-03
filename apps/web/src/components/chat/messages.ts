import {
  isToolUIPart,
  type UIMessage,
  type ToolUIPart,
  type DynamicToolUIPart,
} from 'ai';

export type ChatMessagePart =
  | { type: 'part'; part: UIMessage['parts'][number]; index: number }
  | { type: 'tools'; tools: (ToolUIPart | DynamicToolUIPart)[]; id: string };

export function groupMessageParts(
  message: UIMessage,
  interactiveToolIds?: Set<string>,
): ChatMessagePart[] {
  const groups: ChatMessagePart[] = [];
  for (const [index, part] of message.parts.entries()) {
    if (
      isToolUIPart(part) &&
      !(
        part.type === 'tool-ask_user' ||
        (part.type === 'dynamic-tool' && part.toolName === 'ask_user')
      ) &&
      !interactiveToolIds?.has(part.toolCallId)
    ) {
      const previous = groups.at(-1);
      if (previous?.type === 'tools') previous.tools.push(part);
      else
        groups.push({
          type: 'tools',
          tools: [part],
          id: `${message.id}:${part.toolCallId}`,
        });
    } else groups.push({ type: 'part', part, index });
  }
  return groups;
}

export function groupChatMessages(messages: UIMessage[]) {
  const rows: { message: UIMessage; sourceIds: string[] }[] = [];
  for (const message of messages) {
    const previous = rows.at(-1);
    const lastPart = previous?.message.parts.at(-1);
    const firstPart = message.parts[0];
    if (
      previous?.message.role === 'assistant' &&
      message.role === 'assistant' &&
      lastPart &&
      firstPart &&
      isToolUIPart(lastPart) &&
      isToolUIPart(firstPart)
    ) {
      previous.message = {
        ...previous.message,
        parts: [...previous.message.parts, ...message.parts],
      };
      previous.sourceIds.push(message.id);
    } else rows.push({ message, sourceIds: [message.id] });
  }
  return rows.map((row) => ({ ...row, parts: groupMessageParts(row.message) }));
}

export function mergeMessages(
  current: UIMessage[],
  incoming: UIMessage[],
  older = false,
) {
  const messages = new Map<string, UIMessage>();
  for (const message of older
    ? [...incoming, ...current]
    : [...current, ...incoming])
    messages.set(message.id, message);
  return [...messages.values()];
}
