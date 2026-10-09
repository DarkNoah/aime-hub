import { isToolUIPart, type UIMessage } from 'ai';

function messageCreatedAt(message: UIMessage) {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || !('createdAt' in metadata))
    return;
  const value = metadata.createdAt;
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  )
    return;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? { value, time } : undefined;
}

/** History and SSE windows overlap, but can start at different messages. */
export function sortThreadMessages(messages: UIMessage[]): UIMessage[] {
  let latestTime = -Infinity;
  return (
    messages
      .map((message) => {
        // Anchor undated live drafts to the latest preceding timestamp. A late
        // historical update must not pull a new draft back into older history.
        const time = messageCreatedAt(message)?.time ?? latestTime;
        latestTime = Math.max(latestTime, time);
        return { message, time };
      })
      // Stable sorting preserves the sequence for equal or missing timestamps.
      .sort((a, b) => (a.time === b.time ? 0 : a.time - b.time))
      .map(({ message }) => message)
  );
}

// A persisted result must survive an older runtime/SSE snapshot of the same call.
// Results may still replace other results (for example a background task's ack).
export function mergeThreadMessage(
  current: UIMessage,
  incoming: UIMessage,
): UIMessage {
  if (current.id !== incoming.id) return incoming;
  const createdAt = messageCreatedAt(current);
  if (createdAt && !messageCreatedAt(incoming)) {
    incoming = {
      ...incoming,
      metadata: {
        ...(typeof incoming.metadata === 'object' ? incoming.metadata : {}),
        createdAt: createdAt.value,
      },
    };
  }
  const results = new Map(
    current.parts
      .filter(isToolUIPart)
      .filter(
        (part) =>
          part.state.startsWith('output-') &&
          !('preliminary' in part && part.preliminary),
      )
      .map((part) => [part.toolCallId, part]),
  );
  if (!results.size) return incoming;
  let changed = false;
  const parts = incoming.parts.map((part) => {
    if (!isToolUIPart(part)) return part;
    const previous = results.get(part.toolCallId);
    results.delete(part.toolCallId);
    if (
      previous &&
      (!part.state.startsWith('output-') ||
        ('preliminary' in part && part.preliminary))
    ) {
      changed = true;
      return previous;
    }
    return part;
  });
  // An older cumulative snapshot may end before a completed tool call appears.
  if (results.size) {
    changed = true;
    parts.push(...results.values());
  }
  return changed ? { ...incoming, parts } : incoming;
}
