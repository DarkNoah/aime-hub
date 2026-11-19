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
  if (current.role === 'assistant') {
    const parts = mergeCumulativeParts(current.parts, incoming.parts);
    if (parts) return { ...incoming, parts };
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

function matchingPart(current: Part, incoming: Part) {
  if (current.type !== incoming.type) return false;
  const key = partIdentity(current);
  const otherKey = partIdentity(incoming);
  if (key && otherKey) return key === otherKey;
  if (
    (current.type === 'text' && incoming.type === 'text') ||
    (current.type === 'reasoning' && incoming.type === 'reasoning')
  )
    return (
      current.text.startsWith(incoming.text) ||
      incoming.text.startsWith(current.text)
    );
  return JSON.stringify(current) === JSON.stringify(incoming);
}

// Native history can omit step markers and reasoning from a cumulative snapshot.
// Align substantive parts in order so a stale prefix can update an earlier tool
// without truncating text streamed after it.
function mergeCumulativeParts(current: Part[], incoming: Part[]) {
  const parts: Part[] = [];
  const currentHasReasoning = current.some((part) => part.type === 'reasoning');
  const incomingHasReasoning = incoming.some(
    (part) => part.type === 'reasoning',
  );
  let left = 0;
  let right = 0;
  while (left < current.length && right < incoming.length) {
    const before = current[left];
    const after = incoming[right];
    if (matchingPart(before, after)) {
      parts.push(mergePart(before, after));
      left++;
      right++;
    } else if (
      before.type === 'step-start' ||
      (before.type === 'reasoning' && !incomingHasReasoning)
    ) {
      parts.push(before);
      left++;
    } else if (
      after.type === 'step-start' ||
      (after.type === 'reasoning' && !currentHasReasoning)
    ) {
      parts.push(after);
      right++;
    } else {
      return;
    }
  }
  return [...parts, ...current.slice(left), ...incoming.slice(right)];
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
    const match = current.findIndex(
      (other, index) =>
        index >= cursor &&
        !(partIdentity(part) && partIdentity(other)) &&
        matchingPart(other, part),
    );
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

function interruptedReplyLink(message: UIMessage) {
  if (message.role !== 'assistant') return;
  const link = (
    message.metadata as {
      interruptedReply?: { draftId?: unknown; storedId?: unknown };
    }
  )?.interruptedReply;
  if (typeof link?.draftId === 'string' && typeof link.storedId === 'string')
    return { draftId: link.draftId, storedId: link.storedId };
}

/** Mastra saves an interrupted step as one compact text record. Overlay it only
 * on the assistant ID reported by that run, preserving the original live blocks.
 * Collect both sides first: history, a late write and the live feed can arrive in any order.
 */
function projectInterruptedReplies(
  snapshots: UIMessage[],
  removed: Set<string>,
) {
  const links = new Map<string, string>();
  for (const message of snapshots) {
    const link = interruptedReplyLink(message);
    if (link && !removed.has(message.id))
      links.set(link.storedId, link.draftId);
  }
  if (!links.size) return snapshots;

  const drafts = new Map<string, UIMessage[]>();
  for (const id of links.values()) drafts.set(id, []);
  for (const message of snapshots) {
    if (message.role !== 'assistant' || removed.has(message.id)) continue;
    for (const source of threadMessageSourceIds(message))
      drafts.get(source)?.push(message);
  }
  return snapshots.map((saved) => {
    const draftId = links.get(saved.id);
    const compact = saved.parts[0];
    if (!draftId || saved.parts.length !== 1 || compact.type !== 'text')
      return saved;
    let projected = saved;
    let covered = -1;
    for (const draft of drafts.get(draftId) ?? []) {
      if (draft === saved) continue;
      const parts = draft.parts;
      const types = parts.map((part) => part.type);
      const start = types.lastIndexOf('step-start') + 1;
      const text = parts
        .slice(start)
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('');
      if (
        !(compact.text.startsWith(text) || text.startsWith(compact.text)) ||
        text.length < covered
      )
        continue;
      covered = text.length;
      const updated = [...parts];
      const last = types.lastIndexOf('text');
      const tail = updated[last];
      if (last >= start && tail?.type === 'text') {
        updated[last] = mergePart(
          { ...compact, text: tail.text },
          {
            ...tail,
            text: tail.text + compact.text.slice(text.length),
          },
        );
      } else updated.push(compact);
      projected = {
        ...saved,
        metadata: {
          ...(saved.metadata as object),
          interruptedReply: { draftId, storedId: saved.id },
          reconciledMessageIds: [
            ...new Set([saved.id, ...threadMessageSourceIds(draft)]),
          ],
        },
        parts: updated,
      };
    }
    return projected;
  });
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
  for (const message of projectInterruptedReplies(
    [...current, ...incoming],
    removed,
  )) {
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

function coversStreamedParts(draft: UIMessage, stored: UIMessage) {
  const parts = draft.parts.filter(
    (part) =>
      part.type !== 'step-start' &&
      !((part.type === 'text' || part.type === 'reasoning') && !part.text),
  );
  let cursor = -1;
  return (
    parts.length > 0 &&
    parts.every((part) => {
      cursor = stored.parts.findIndex((other, index) => {
        if (index <= cursor || other.type !== part.type) return false;
        const key = partIdentity(part);
        const otherKey = partIdentity(other);
        if (key && otherKey) return key === otherKey;
        if (part.type === 'text' && other.type === 'text')
          return other.text.startsWith(part.text);
        return JSON.stringify(part) === JSON.stringify(other);
      });
      return cursor >= 0;
    })
  );
}

/** Finished streams may have text-only aliases without shared tool/provider IDs. */
export function reconcileThreadMessages(
  current: UIMessage[],
  persisted: UIMessage[],
  streamedMessageIds: string[],
) {
  if (!streamedMessageIds.length)
    return mergeThreadMessages(current, persisted);
  const streamed = new Set(streamedMessageIds);
  const ids = new Set(persisted.map((message) => message.id));
  // Without a shared identity, only compare drafts in the latest matching turn.
  const lastBoundary = (messages: UIMessage[]) =>
    messages.reduce(
      (last, message, index) => (message.role === 'assistant' ? last : index),
      -1,
    );
  const liveBoundary = lastBoundary(current);
  const savedBoundary = lastBoundary(persisted);
  const candidates = persisted
    .slice(savedBoundary + 1)
    .filter((m) => !streamed.has(m.id) && !interruptedReplyLink(m));
  const matches = new Map<string, UIMessage>();
  const claims = new Map<string, number>();
  if (
    liveBoundary < 0 ||
    current[liveBoundary].id === persisted[savedBoundary]?.id
  ) {
    for (const draft of current.slice(liveBoundary + 1)) {
      if (!streamed.has(draft.id) || ids.has(draft.id)) continue;
      const covered = candidates.filter((m) => coversStreamedParts(draft, m));
      for (const stored of covered)
        claims.set(stored.id, (claims.get(stored.id) ?? 0) + 1);
      if (covered.length === 1) matches.set(draft.id, covered[0]);
    }
  }
  const remaining = current.map((draft) => {
    const saved = matches.get(draft.id);
    return saved && claims.get(saved.id) === 1
      ? mergeOverlappingMessages(draft, saved)
      : draft;
  });
  return mergeThreadMessages(remaining, persisted);
}
