import { isToolUIPart, type UIMessage } from 'ai';
import {
  isThreadActive,
  type ThreadSummary,
  type ToolInteraction,
} from './threads.js';

/** A stopped tool turn can continue from history without adding user input. */
export function canContinueThread(
  messages: readonly UIMessage[],
  thread: Pick<ThreadSummary, 'status' | 'error'> | null | undefined,
  interactions: readonly ToolInteraction[] = [],
) {
  if (
    !thread ||
    thread.error ||
    isThreadActive(thread.status) ||
    thread.status === 'suspended' ||
    thread.status === 'waiting' ||
    interactions.some((interaction) => !interaction.response)
  )
    return false;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') return false;
    if (
      message.parts.some(
        (part) =>
          isToolUIPart(part) &&
          part.state === 'approval-requested' &&
          !interactions.some(
            (interaction) =>
              interaction.toolCallId === part.toolCallId &&
              interaction.response,
          ),
      )
    )
      return false;
    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex--
    ) {
      const part = message.parts[partIndex];
      if (
        part.type.startsWith('data-') ||
        part.type.startsWith('step-') ||
        (part.type === 'text' && !part.text.trim())
      )
        continue;
      return isToolUIPart(part) && part.state !== 'output-error';
    }
  }
  return false;
}

function messageCreatedAt(message: UIMessage, field = 'createdAt') {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || !(field in metadata)) return;
  const value = (metadata as Record<string, unknown>)[field];
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
        const time =
          messageCreatedAt(message, 'signalCreatedAt')?.time ??
          messageCreatedAt(message)?.time ??
          latestTime;
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
  // Once a stream has been associated with a stored message, either source can
  // still send an older snapshot. Keep the other source's unsaved suffix.
  if (threadMessageSourceIds(current).length > 1)
    return mergeOverlappingMessages(current, incoming);
  // Storage can lag behind the stream even when it keeps the same message ID.
  // A shorter cumulative snapshot must not erase the unsaved end of the turn.
  if (
    current.role === 'assistant' &&
    incoming.parts.every((part, index) => {
      const previous = current.parts[index];
      if (!previous || part.type !== previous.type) return false;
      const key = partIdentity(part);
      const previousKey = partIdentity(previous);
      if (key && previousKey) return key === previousKey;
      if (
        (part.type === 'text' && previous.type === 'text') ||
        (part.type === 'reasoning' && previous.type === 'reasoning')
      )
        return (
          part.text.startsWith(previous.text) ||
          previous.text.startsWith(part.text)
        );
      return JSON.stringify(part) === JSON.stringify(previous);
    })
  )
    return {
      ...incoming,
      parts: [
        ...incoming.parts.map((part, index) =>
          mergePart(current.parts[index], part),
        ),
        ...current.parts.slice(incoming.parts.length),
      ],
    };
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

type Part = UIMessage['parts'][number];

export function threadMessageSourceIds(message: UIMessage): string[] {
  const metadata = message.metadata as
    { reconciledMessageIds?: unknown } | undefined;
  const ids = metadata?.reconciledMessageIds;
  return [
    ...new Set([
      message.id,
      ...(Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === 'string')
        : []),
    ]),
  ];
}

function partIdentity(part: Part): string | undefined {
  if (isToolUIPart(part)) return `tool:${part.toolCallId}`;
  if ('providerMetadata' in part && part.providerMetadata) {
    for (const [provider, value] of Object.entries(part.providerMetadata)) {
      if (
        value &&
        typeof value === 'object' &&
        typeof value.itemId === 'string'
      )
        return `${part.type}:${provider}:${value.itemId}`;
    }
  }
  if (part.type.startsWith('data-') && 'id' in part && part.id)
    return `${part.type}:${part.id}`;
}

function mergePart(current: Part, incoming: Part): Part {
  if (isToolUIPart(current) && isToolUIPart(incoming)) {
    if (
      current.state !== 'input-streaming' &&
      incoming.state === 'input-streaming'
    )
      return current;
    if (
      current.state.startsWith('output-') &&
      !('preliminary' in current && current.preliminary) &&
      (!incoming.state.startsWith('output-') ||
        ('preliminary' in incoming && incoming.preliminary))
    )
      return current;
  }
  if (
    (current.type === 'text' && incoming.type === 'text') ||
    (current.type === 'reasoning' && incoming.type === 'reasoning')
  ) {
    const part =
      current.text.length > incoming.text.length &&
      current.text.startsWith(incoming.text)
        ? current
        : incoming;
    const createdAt =
      part.providerMetadata?.mastra?.createdAt ??
      current.providerMetadata?.mastra?.createdAt ??
      incoming.providerMetadata?.mastra?.createdAt;
    // Live snapshots may omit the native part timestamp stored in history.
    // Retain it even when the longer text comes from the other snapshot.
    if (
      createdAt !== undefined &&
      part.providerMetadata?.mastra?.createdAt === undefined
    )
      return {
        ...part,
        providerMetadata: {
          ...part.providerMetadata,
          mastra: { ...part.providerMetadata?.mastra, createdAt },
        },
      };
    return part;
  }
  return incoming;
}

// Align stable call/provider IDs first. Only compare unkeyed text inside the
// gaps between those anchors, so identical replies in unrelated turns survive.
function mergePartGap(current: Part[], incoming: Part[]): Part[] {
  const result: Part[] = [];
  let cursor = 0;
  let incomingCursor = 0;
  for (const [partIndex, part] of incoming.entries()) {
    const match = current.findIndex((other, index) => {
      if (
        index < cursor ||
        (partIdentity(part) && partIdentity(other)) ||
        part.type !== other.type
      )
        return false;
      if (
        (part.type === 'text' && other.type === 'text') ||
        (part.type === 'reasoning' && other.type === 'reasoning')
      )
        return (
          part.text.startsWith(other.text) || other.text.startsWith(part.text)
        );
      return JSON.stringify(part) === JSON.stringify(other);
    });
    if (match >= 0) {
      result.push(
        ...current.slice(cursor, match),
        ...incoming.slice(incomingCursor, partIndex),
        mergePart(current[match], part),
      );
      cursor = match + 1;
      incomingCursor = partIndex + 1;
    }
  }
  return [
    ...result,
    ...current.slice(cursor),
    ...incoming.slice(incomingCursor),
  ];
}

function mergeParts(current: Part[], incoming: Part[]): Part[] {
  const positions = new Map(
    current.flatMap((part, index) => {
      const key = partIdentity(part);
      return key ? [[key, index] as const] : [];
    }),
  );
  const result: Part[] = [];
  let left = 0;
  let right = 0;
  for (const [index, part] of incoming.entries()) {
    const key = partIdentity(part);
    const match = key ? positions.get(key) : undefined;
    if (match === undefined || match < left) continue;
    result.push(
      ...mergePartGap(current.slice(left, match), incoming.slice(right, index)),
      mergePart(current[match], part),
    );
    left = match + 1;
    right = index + 1;
  }
  result.push(...mergePartGap(current.slice(left), incoming.slice(right)));
  // Replayed snapshots can also contain the same call twice within one source.
  const unique: Part[] = [];
  const seen = new Map<string, number>();
  for (const part of result) {
    const key = partIdentity(part);
    const index = key ? seen.get(key) : undefined;
    if (index !== undefined) unique[index] = mergePart(unique[index], part);
    else {
      if (key) seen.set(key, unique.length);
      unique.push(part);
    }
  }
  return unique;
}

function mergeOverlappingMessages(
  current: UIMessage,
  incoming: UIMessage,
): UIMessage {
  const canonical =
    !messageCreatedAt(current) && messageCreatedAt(incoming)
      ? incoming
      : current;
  const ids = [
    ...new Set([
      ...threadMessageSourceIds(current),
      ...threadMessageSourceIds(incoming),
    ]),
  ];
  return {
    ...canonical,
    metadata: {
      ...(typeof current.metadata === 'object' ? current.metadata : {}),
      ...(typeof incoming.metadata === 'object' ? incoming.metadata : {}),
      ...(messageCreatedAt(canonical)
        ? { createdAt: messageCreatedAt(canonical)!.value }
        : {}),
      reconciledMessageIds: ids,
    },
    parts: mergeParts(current.parts, incoming.parts),
  };
}

/** Coalesce live/stored identities without dropping content absent from storage. */
export function mergeThreadMessages(
  current: UIMessage[],
  incoming: UIMessage[],
  removedMessageIds: string[] = [],
): UIMessage[] {
  const removed = new Set(removedMessageIds);
  const messages = new Map<string, UIMessage>();
  const aliases = new Map<string, string>();
  for (const message of [...current, ...incoming]) {
    if (removed.has(message.id)) continue;
    // A reconnect can introduce the canonical message after the client has
    // already received a text-only draft. Its source IDs are proof of overlap
    // even when there are no shared calls/provider IDs left in the snapshot.
    const matchingIds = new Set(
      threadMessageSourceIds(message)
        .map((source) => aliases.get(source))
        .filter((id): id is string => id !== undefined),
    );
    let previous: UIMessage | undefined;
    for (const id of matchingIds) {
      const match = messages.get(id);
      if (match)
        previous = previous ? mergeOverlappingMessages(previous, match) : match;
    }
    const merged = previous
      ? previous.id === message.id
        ? mergeThreadMessage(previous, message)
        : mergeOverlappingMessages(previous, message)
      : message;
    for (const id of matchingIds) if (id !== merged.id) messages.delete(id);
    messages.set(merged.id, merged);
    for (const source of threadMessageSourceIds(merged))
      aliases.set(source, merged.id);
  }
  const result: UIMessage[] = [];
  let blockStart = 0;
  for (const message of sortThreadMessages([...messages.values()])) {
    if (message.role !== 'assistant') {
      result.push(message);
      blockStart = result.length;
      continue;
    }
    let merged = message;
    let target = result.length;
    const keys = new Set(message.parts.map(partIdentity).filter(Boolean));
    for (let index = result.length - 1; index >= blockStart; index--) {
      const previous = result[index];
      if (!previous.parts.some((part) => keys.has(partIdentity(part))))
        continue;
      merged = mergeOverlappingMessages(previous, merged);
      for (const part of previous.parts) {
        const key = partIdentity(part);
        if (key) keys.add(key);
      }
      result.splice(index, 1);
      target = index;
    }
    result.splice(target, 0, merged);
  }
  return result;
}

/** Finished streams may have text-only aliases without shared tool/provider IDs. */
export function reconcileThreadMessages(
  current: UIMessage[],
  persisted: UIMessage[],
  streamedMessageIds: string[],
) {
  const saved = [...persisted];
  const ids = new Set(saved.map((message) => message.id));
  const streamed = new Set(streamedMessageIds);
  // Text equality alone is only sufficient after this turn has stopped and
  // only against its final assistant block, never an older identical answer.
  const lastBoundary = saved.reduce(
    (last, message, index) => (message.role !== 'assistant' ? index : last),
    -1,
  );
  const remaining = current.map((message) => {
    if (
      message.role !== 'assistant' ||
      ids.has(message.id) ||
      !streamed.has(message.id)
    )
      return message;
    const parts = message.parts.filter(
      (part) =>
        !part.type.startsWith('step-') &&
        !((part.type === 'reasoning' || part.type === 'text') && !part.text),
    );
    if (!parts.length) return message;
    for (let index = saved.length - 1; index > lastBoundary; index--) {
      const candidate = saved[index];
      let cursor = 0;
      const covered = parts.every((part) => {
        const match = candidate.parts.findIndex((other, i) => {
          if (i < cursor || part.type !== other.type) return false;
          const key = partIdentity(part);
          const otherKey = partIdentity(other);
          if (key && otherKey) return key === otherKey;
          if (part.type === 'text' && other.type === 'text')
            return other.text.startsWith(part.text);
          return JSON.stringify(part) === JSON.stringify(other);
        });
        if (match < 0) return false;
        cursor = match + 1;
        return true;
      });
      if (covered) {
        saved[index] = mergeOverlappingMessages(message, candidate);
        return saved[index];
      }
    }
    return message;
  });
  return mergeThreadMessages(remaining, saved);
}
