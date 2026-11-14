import { isToolUIPart, type UIMessage } from 'ai';
import { threadMessageSourceIds } from '@aime/shared/thread-messages';
import { ThreadError } from './errors.js';

/** Keep attachment bytes out of overview JSON, including legacy user signals. */
export function projectUserMedia(
  message: UIMessage | null,
  threadId: string,
  turnId: string,
  cursor?: string,
): UIMessage | null {
  if (!message) return null;
  return {
    ...message,
    parts: message.parts.map((part, partIndex) => {
      if (part.type !== 'file' || !part.url.startsWith('data:')) return part;
      const query = new URLSearchParams({
        messageId: message.id,
        partIndex: String(partIndex),
      });
      if (cursor) query.set('cursor', cursor);
      return {
        ...part,
        url: `/api/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/media?${query}`,
      };
    }),
  };
}

export type ThreadMediaLocator = {
  messageId: string;
  partIndex?: number;
  toolCallId?: string;
  contentIndex?: number;
};

/** Shared legacy content detection for URL projection and subsequent byte reads. */
export function inlineToolMedia(item: Record<string, unknown>) {
  const mediaType =
    typeof item.mimeType === 'string'
      ? item.mimeType
      : typeof item.mediaType === 'string'
        ? item.mediaType
        : undefined;
  if (
    !/^(image|audio|video|file)(?:-data|-url)?$/.test(String(item.type)) &&
    !(mediaType && /^(image|audio|video)\//.test(mediaType))
  )
    return;
  const source =
    typeof item.data === 'string'
      ? item.data
      : typeof item.image === 'string' && !/^https?:/i.test(item.image)
        ? item.image
        : typeof item.url === 'string' && item.url.startsWith('data:')
          ? item.url
          : undefined;
  if (source && (source.startsWith('data:') || mediaType))
    return { source, mediaType };
}

function mediaData(value: string, mediaType?: string) {
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    if (comma < 0) throw new ThreadError('FILE_NOT_FOUND', 404);
    const header = value.slice(5, comma);
    const content = value.slice(comma + 1);
    return {
      data: /;base64(?:;|$)/i.test(header)
        ? Buffer.from(content, 'base64')
        : Buffer.from(decodeURIComponent(content)),
      mediaType:
        header.split(';')[0] || mediaType || 'application/octet-stream',
    };
  }
  if (!mediaType) throw new ThreadError('FILE_NOT_FOUND', 404);
  return { data: Buffer.from(value, 'base64'), mediaType };
}

/** Only resolve bytes already owned by the authorized turn, never a supplied URL. */
export function readThreadMedia(
  messages: UIMessage[],
  locator: ThreadMediaLocator,
) {
  const message = messages.find((item) =>
    threadMessageSourceIds(item).includes(locator.messageId),
  );
  if (!message) throw new ThreadError('FILE_NOT_FOUND', 404);
  if (locator.toolCallId) {
    const part = message.parts.find(
      (part) => isToolUIPart(part) && part.toolCallId === locator.toolCallId,
    );
    if (!part || !isToolUIPart(part) || part.state !== 'output-available')
      throw new ThreadError('FILE_NOT_FOUND', 404);
    let output = part.output;
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output) as unknown;
      } catch {
        throw new ThreadError('FILE_NOT_FOUND', 404);
      }
    }
    const content =
      output && typeof output === 'object' && 'content' in output
        ? output.content
        : undefined;
    const item = Array.isArray(content)
      ? (content[locator.contentIndex ?? 0] as
          Record<string, unknown> | undefined)
      : undefined;
    const inline = item && inlineToolMedia(item);
    if (!inline) throw new ThreadError('FILE_NOT_FOUND', 404);
    return mediaData(inline.source, inline.mediaType);
  }
  const part = message.parts[locator.partIndex ?? -1];
  if (part?.type !== 'file' || !part.url.startsWith('data:'))
    throw new ThreadError('FILE_NOT_FOUND', 404);
  return mediaData(part.url, part.mediaType);
}
