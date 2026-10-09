import type { UIMessage } from 'ai';

type MessagePart = UIMessage['parts'][number];

export interface MessageCompression {
  cycleId: string;
  status: 'running' | 'buffered' | 'completed' | 'failed';
  tokensBefore?: number;
  tokensAfter?: number;
  durationMs?: number;
}

function nonNegativeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function getMessageCompression(
  part: MessagePart,
): MessageCompression | null {
  if (
    part.type !== 'data-om-observation-start' &&
    part.type !== 'data-om-observation-end' &&
    part.type !== 'data-om-observation-failed' &&
    part.type !== 'data-om-buffering-start' &&
    part.type !== 'data-om-buffering-end' &&
    part.type !== 'data-om-buffering-failed' &&
    part.type !== 'data-om-activation'
  )
    return null;
  const data = part.data;
  if (
    !data ||
    typeof data !== 'object' ||
    !('cycleId' in data) ||
    typeof data.cycleId !== 'string' ||
    !data.cycleId.trim()
  )
    return null;

  const activated = part.type === 'data-om-activation';
  const completed = activated || part.type === 'data-om-observation-end';
  const buffered = part.type === 'data-om-buffering-end';
  const failed = part.type.endsWith('-failed');
  const beforeKey = activated
    ? 'tokensActivated'
    : completed
      ? 'tokensObserved'
      : buffered
        ? 'tokensBuffered'
        : failed
          ? 'tokensAttempted'
          : part.type === 'data-om-buffering-start'
            ? 'tokensToBuffer'
            : 'tokensToObserve';
  return {
    cycleId: data.cycleId,
    status: completed
      ? 'completed'
      : failed
        ? 'failed'
        : buffered
          ? 'buffered'
          : 'running',
    tokensBefore: nonNegativeNumber(
      (data as Record<string, unknown>)[beforeKey],
    ),
    tokensAfter:
      completed && 'observationTokens' in data
        ? nonNegativeNumber(data.observationTokens)
        : undefined,
    durationMs:
      'durationMs' in data ? nonNegativeNumber(data.durationMs) : undefined,
  };
}

// Select one visible event per cycle, including when its events span messages.
// Activation wins over buffered results, including out-of-order history replay.
const statusPriority = { running: 0, buffered: 1, failed: 2, completed: 3 };

export function getMessageCompressions(messages: UIMessage[]) {
  const cycles = new Map<
    string,
    { part: MessagePart; compression: MessageCompression }
  >();
  for (const message of messages) {
    for (const part of message.parts) {
      const compression = getMessageCompression(part);
      if (!compression) continue;
      const previous = cycles.get(compression.cycleId);
      if (
        !previous ||
        statusPriority[compression.status] >=
          statusPriority[previous.compression.status]
      )
        cycles.set(compression.cycleId, { part, compression });
    }
  }
  return new Map(
    [...cycles.values()].map(({ part, compression }) => [part, compression]),
  );
}
