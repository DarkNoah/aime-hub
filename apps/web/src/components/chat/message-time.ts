import type { UIMessage } from 'ai';

export function messageDate(metadata: UIMessage['metadata']) {
  if (!metadata || typeof metadata !== 'object' || !('createdAt' in metadata))
    return;
  const value = metadata.createdAt;
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  )
    return;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function lastTextDate(message: UIMessage) {
  const part = message.parts.findLast(
    (part) => part.type === 'text' && part.text.trim(),
  );
  // Mastra keeps the whole message's createdAt from its first step. The final
  // text can arrive much later, after tools or background tasks have finished.
  return part?.type === 'text'
    ? messageDate(part.providerMetadata?.mastra)
    : undefined;
}

export function formatMessageElapsedTime(elapsedMs: number | undefined) {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0)
    return;
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
