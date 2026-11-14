import { isToolUIPart, type UIMessage } from 'ai';

/** Detail pages contain disjoint parts, unlike cumulative live message snapshots. */
export function appendToolGroupPage(
  current: UIMessage[],
  incoming: UIMessage[],
): UIMessage[] {
  const messages = [...current];
  const positions = new Map(
    messages.map((message, index) => [message.id, index]),
  );
  for (const message of incoming) {
    const position = positions.get(message.id);
    if (position === undefined) {
      positions.set(message.id, messages.length);
      messages.push(message);
      continue;
    }
    const previous = messages[position];
    const parts = [...previous.parts];
    const tools = new Map(
      parts.flatMap((part, index) =>
        isToolUIPart(part) ? [[part.toolCallId, index] as const] : [],
      ),
    );
    for (const part of message.parts) {
      const index = isToolUIPart(part) ? tools.get(part.toolCallId) : undefined;
      if (index === undefined) {
        if (isToolUIPart(part)) tools.set(part.toolCallId, parts.length);
        parts.push(part);
      } else parts[index] = part;
    }
    messages[position] = { ...previous, ...message, parts };
  }
  return messages;
}
