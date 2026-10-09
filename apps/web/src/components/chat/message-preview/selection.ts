import { isToolUIPart, type UIMessage } from 'ai';
import {
  getMessageCompression,
  getMessageCompressions,
} from '../message-compression.js';

export type PreviewPart = UIMessage['parts'][number];
export type MessagePreviewSelection =
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'compression'; cycleId: string }
  | { kind: 'part'; messageId: string; index: number };

export function selectMessagePart(
  messages: UIMessage[],
  part: PreviewPart,
): MessagePreviewSelection | null {
  if (isToolUIPart(part)) return { kind: 'tool', toolCallId: part.toolCallId };
  const compression = getMessageCompression(part);
  if (compression) return { kind: 'compression', cycleId: compression.cycleId };
  for (const message of messages) {
    const index = message.parts.indexOf(part);
    if (index !== -1) return { kind: 'part', messageId: message.id, index };
  }
  return null;
}

// Resolve against live messages so a selected tool keeps receiving stream updates.
export function resolveMessagePart(
  messages: UIMessage[],
  selection: MessagePreviewSelection | null,
): PreviewPart | null {
  if (!selection) return null;
  if (selection.kind === 'compression') {
    for (const [part, compression] of getMessageCompressions(messages))
      if (compression.cycleId === selection.cycleId) return part;
    return null;
  }
  if (selection.kind === 'part')
    return (
      messages.find((message) => message.id === selection.messageId)?.parts[
        selection.index
      ] ?? null
    );
  for (const message of messages)
    for (const part of message.parts)
      if (isToolUIPart(part) && part.toolCallId === selection.toolCallId)
        return part;
  return null;
}
