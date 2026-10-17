import type { FileUIPart, UIMessage } from 'ai';
import { MAX_IMAGE_BYTES } from './threads.js';
import {
  fileMediaTypes,
  workspaceReferencePath,
  type WorkspaceFileReference,
} from './files.js';

export type MessageAttachment = FileUIPart & {
  id: string;
  workspacePath?: string;
  size?: number;
};

export type AttachmentMetadata = {
  path?: string;
  size?: number;
  mimeType: string;
  width?: number;
  height?: number;
  /** Seconds. */
  duration?: number;
  /** Hertz. */
  sampleRate?: number;
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

export function attachmentAttributes(item: Partial<AttachmentMetadata>) {
  const attributes: Record<string, string | number | undefined> = {
    path: item.path,
    size: item.size,
    mimeType: item.mimeType,
  };
  if (item.mimeType?.startsWith('image/')) {
    attributes.width = item.width;
    attributes.height = item.height;
  } else if (item.mimeType?.startsWith('video/')) {
    attributes.duration = item.duration;
  } else if (item.mimeType?.startsWith('audio/')) {
    attributes.duration = item.duration;
    attributes.sampleRate = item.sampleRate;
  }
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(' ');
}

/** Storage/UI metadata; the server inserts supported media inside paired tags. */
export function serializeAttachments(items: AttachmentMetadata[]) {
  return items
    .map((item) => `<attachment ${attachmentAttributes(item)}></attachment>`)
    .join('\n');
}

/** Resolve only workspace paths and the explicit personal shared-folder prefix. */
export function attachmentFileReference(
  path: string,
): WorkspaceFileReference | undefined {
  const scope = path.startsWith('../shared/') ? 'shared' : 'thread';
  const kind = path.endsWith('/') ? 'directory' : 'file';
  const relative = (
    scope === 'shared'
      ? path.slice('../shared/'.length)
      : path.replace(/^(?:\.\/|\/)/, '')
  ).replace(/\/$/, '');
  if (
    !relative ||
    path.length > 2048 ||
    path.includes(':') ||
    path.includes('\\') ||
    Array.from(path).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    relative
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  )
    return;
  return { scope, kind, path: relative };
}

function attachmentMimeType(path: string) {
  if (path.endsWith('/')) return 'inode/directory';
  const extension = /\.[^./]+$/.exec(path)?.[0].toLowerCase();
  return (
    (extension && fileMediaTypes[extension]?.[1]) || 'application/octet-stream'
  );
}

export function workspaceAttachmentParts(references: WorkspaceFileReference[]) {
  return references.length
    ? [
        {
          type: 'text' as const,
          text: serializeAttachments(
            references.map((reference) => {
              const path = workspaceReferencePath(reference);
              return { path, mimeType: attachmentMimeType(path) };
            }),
          ),
        },
      ]
    : [];
}

const workspaceReferencesHeader =
  'Referenced workspace files and folders (paths relative to the workspace):';

function parseAttachmentText(text: string): MessageAttachment[] | null {
  const trimmed = text.trim();
  if (
    trimmed.startsWith(
      'Attached generated assets (paths relative to this conversation workspace):\n',
    )
  ) {
    const attachments: MessageAttachment[] = [];
    for (const line of trimmed.split('\n').slice(1)) {
      const match =
        /^- ("(?:\\.|[^"\\])*") \(([^()]+)\): ("(?:\\.|[^"\\])*")$/.exec(line);
      if (!match) return null;
      try {
        const filename = JSON.parse(match[1]) as string;
        const path = JSON.parse(match[3]) as string;
        if (!attachmentFileReference(path)) return null;
        attachments.push({
          id: path,
          type: 'file',
          filename,
          workspacePath: path,
          mediaType: match[2],
          url: '',
        });
      } catch {
        return null;
      }
    }
    return attachments.length ? attachments : null;
  }
  const uploaded = trimmed.startsWith('Uploaded files (workspace paths):\n');
  if (uploaded || trimmed.startsWith(`${workspaceReferencesHeader}\n`)) {
    const attachments: MessageAttachment[] = [];
    for (const line of trimmed.split('\n').slice(1)) {
      if (!line.startsWith('- ')) return null;
      let path: unknown;
      try {
        path = JSON.parse(line.slice(2));
      } catch {
        return null;
      }
      if (
        typeof path !== 'string' ||
        (uploaded && !path.startsWith('/.uploads/')) ||
        !attachmentFileReference(path)
      )
        return null;
      const filename = path.replace(/\/$/, '').split('/').at(-1)!;
      attachments.push({
        id: path,
        type: 'file',
        filename,
        workspacePath: path,
        mediaType: attachmentMimeType(path),
        url: '',
      });
    }
    return attachments.length ? attachments : null;
  }

  const block = /^<attachments>\s*([\s\S]*?)\s*<\/attachments>$/.exec(trimmed);
  const content = block?.[1] ?? trimmed;
  const attachments: MessageAttachment[] = [];
  const entries =
    /<attachment((?:\s+[a-zA-Z]+="[^"<>]*")*)\s*(?:\/>|>\s*<\/attachment>)/g;
  let end = 0;
  for (const match of content.matchAll(entries)) {
    if (content.slice(end, match.index).trim()) return null;
    end = match.index + match[0].length;
    const attributes: Record<string, string> = {};
    for (const [, key, value] of match[1].matchAll(/([a-zA-Z]+)="([^"]*)"/g)) {
      if (key in attributes || /&(?!(?:amp|lt|gt|quot|apos);)/.test(value))
        return null;
      attributes[key] = unescapeXml(value);
    }
    const { path, name, size, mimeType } = attributes;
    if (
      !path ||
      !attachmentFileReference(path) ||
      (size !== undefined &&
        (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size))))
    )
      return null;
    attachments.push({
      id: path,
      type: 'file',
      filename: name || path.replace(/\/$/, '').split('/').at(-1),
      workspacePath: path,
      ...(size === undefined ? {} : { size: Number(size) }),
      mediaType: mimeType || attachmentMimeType(path),
      url: '',
    });
  }
  return attachments.length && !content.slice(end).trim() ? attachments : null;
}

// Queue edits and history conversions can join the body and metadata into one text part.
export function splitAttachmentText(text: string) {
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
      if (close < 0) {
        body.push(...lines.slice(index));
        break;
      }
      end = close;
    } else if (
      !fence &&
      (line === 'Uploaded files (workspace paths):' ||
        line === workspaceReferencesHeader ||
        line ===
          'Attached generated assets (paths relative to this conversation workspace):')
    ) {
      while (lines[end + 1]?.startsWith('- ')) end++;
    }
    const parsed =
      !fence && (end > index || line.startsWith('<attachment '))
        ? parseAttachmentText(lines.slice(index, end + 1).join('\n'))
        : null;
    if (parsed) {
      attachments.push(...parsed);
      index = end;
    } else {
      body.push(...lines.slice(index, end + 1));
      index = end;
    }
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
