import type { FileUIPart, UIMessage } from 'ai';
import { MAX_IMAGE_BYTES } from '@aime/shared/threads';

export type MessageAttachment = FileUIPart & {
  id: string;
  workspacePath?: string;
  size?: number;
};

type AttachmentMetadata = {
  id: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
};

const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
const escapeXml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => entities[character]);
const unescapeXml = (value: string) =>
  value.replace(/&(amp|lt|gt|quot|apos);/g, (entity) =>
    Object.keys(entities).find((key) => entities[key] === entity)!,
  );

/** One text part keeps four image uploads within the input's eight-part limit. */
export function serializeAttachments(items: AttachmentMetadata[]) {
  return `<attachments>\n${items
    .map(
      (item) =>
        `<attachment ${Object.entries(item)
          .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
          .join(' ')} />`,
    )
    .join('\n')}\n</attachments>`;
}

function isUploadPath(path: string) {
  return (
    path.startsWith('/.uploads/') &&
    !path.includes('\\') &&
    !Array.from(path).some((character) => character.charCodeAt(0) < 32) &&
    path
      .slice(1)
      .split('/')
      .every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function parseAttachmentText(text: string): MessageAttachment[] | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('Uploaded files (workspace paths):\n')) {
    const attachments: MessageAttachment[] = [];
    for (const line of trimmed.split('\n').slice(1)) {
      if (!line.startsWith('- ')) return null;
      let path: unknown;
      try {
        path = JSON.parse(line.slice(2));
      } catch {
        return null;
      }
      if (typeof path !== 'string' || !isUploadPath(path)) return null;
      const filename = path.split('/').at(-1)!;
      attachments.push({
        id: path,
        type: 'file',
        filename,
        workspacePath: path,
        mediaType:
          imageTypes[filename.split('.').at(-1)!.toLowerCase()] ??
          'application/octet-stream',
        url: '',
      });
    }
    return attachments.length ? attachments : null;
  }

  const block = /^<attachments>\s*([\s\S]*?)\s*<\/attachments>$/.exec(trimmed);
  if (!block) return null;
  const attachments: MessageAttachment[] = [];
  const entries = /<attachment((?:\s+[a-zA-Z]+="[^"<>]*")*)\s*\/>/g;
  let end = 0;
  for (const match of block[1].matchAll(entries)) {
    if (block[1].slice(end, match.index).trim()) return null;
    end = match.index + match[0].length;
    const attributes: Record<string, string> = {};
    for (const [, key, value] of match[1].matchAll(/([a-zA-Z]+)="([^"]*)"/g)) {
      if (key in attributes || /&(?!(?:amp|lt|gt|quot|apos);)/.test(value))
        return null;
      attributes[key] = unescapeXml(value);
    }
    const { id, path, name, size, mimeType } = attributes;
    if (
      !id ||
      !name ||
      !path ||
      !isUploadPath(path) ||
      !/^\d+$/.test(size ?? '') ||
      !Number.isSafeInteger(Number(size)) ||
      !mimeType
    )
      return null;
    attachments.push({
      id: path,
      type: 'file',
      filename: name,
      workspacePath: path,
      size: Number(size),
      mediaType: mimeType,
      url: '',
    });
  }
  return attachments.length && !block[1].slice(end).trim() ? attachments : null;
}

// Queue edits and history conversions can join the body and metadata into one text part.
function splitAttachmentText(text: string) {
  const lines = text.split('\n');
  const body: string[] = [];
  const attachments: MessageAttachment[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
      body.push(line);
      continue;
    }
    let end = index;
    if (!fence && line === '<attachments>') {
      const close = lines.indexOf('</attachments>', index + 1);
      if (close >= 0) end = close;
    } else if (!fence && line === 'Uploaded files (workspace paths):') {
      while (lines[end + 1]?.startsWith('- ')) end++;
    }
    const parsed =
      end > index
        ? parseAttachmentText(lines.slice(index, end + 1).join('\n'))
        : null;
    if (parsed) {
      attachments.push(...parsed);
      index = end;
    } else body.push(line);
  }
  return {
    text: attachments.length ? body.join('\n').trim() : text,
    attachments,
  };
}

/** Only user metadata parts are hidden. Malformed XML and ordinary prose stay visible. */
export function splitMessageAttachments(message: UIMessage) {
  if (message.role !== 'user') return { parts: message.parts, attachments: [] };
  const attachments: MessageAttachment[] = [];
  const files: { part: FileUIPart; index: number }[] = [];
  const parts = message.parts.flatMap<UIMessage['parts'][number]>(
    (part, index) => {
      if (part.type === 'file') {
        files.push({ part, index });
        return [];
      }
      if (part.type !== 'text') return [part];
      const parsed = splitAttachmentText(part.text);
      attachments.push(...parsed.attachments);
      return parsed.attachments.length
        ? parsed.text
          ? [{ ...part, text: parsed.text }]
          : []
        : [part];
    },
  );
  const used = new Set<number>();
  for (const attachment of attachments) {
    if (attachment.size !== undefined && attachment.size > MAX_IMAGE_BYTES)
      continue;
    const file = files.find(
      ({ part, index }) =>
        !used.has(index) &&
        part.filename === attachment.filename &&
        part.mediaType === attachment.mediaType,
    );
    if (!file) continue;
    attachment.url = file.part.url;
    attachment.mediaType = file.part.mediaType;
    used.add(file.index);
  }
  for (const { part, index } of files) {
    if (!used.has(index))
      attachments.push({ ...part, id: `${message.id}:${index}` });
  }
  return { parts, attachments };
}
