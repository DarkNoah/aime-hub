export type ReadFileBlock =
  | { type: 'text'; text: string }
  | {
      type: 'media';
      mediaType: string;
      source?: string;
      filename?: string;
    }
  | { type: 'unknown'; value: unknown };

const imageExtensions: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

function mimeType(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const mime = value.split(';', 1)[0].trim().toLowerCase();
  return /^[\w!#$&^.+-]+\/(?:[\w!#$&^.+-]+|\*)$/.test(mime) ? mime : undefined;
}

function imageType(base64: string, filename?: string) {
  // Inspect only the header, never decode an entire large image to guess its type.
  try {
    const header = atob(base64.slice(0, 64));
    if (header.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
    if (header.startsWith('\xff\xd8\xff')) return 'image/jpeg';
    if (/^GIF8[79]a/.test(header)) return 'image/gif';
    if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP')
      return 'image/webp';
    if (header.slice(4, 8) === 'ftyp' && /avif|avis/.test(header.slice(8)))
      return 'image/avif';
    if (header.startsWith('BM')) return 'image/bmp';
    if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(header)) return 'image/svg+xml';
  } catch {
    /* Invalid data falls back to the filename or a media error state. */
  }
  const extension = filename
    ?.split(/[?#]/, 1)[0]
    .split('.')
    .at(-1)
    ?.toLowerCase();
  return extension ? imageExtensions[extension] : undefined;
}

export function resolveMediaSource(
  value: unknown,
  declaredType: unknown,
  filename?: string,
  isUrl = false,
) {
  let mediaType = mimeType(declaredType) ?? 'application/octet-stream';
  if (typeof value !== 'string' || !value.trim()) return { mediaType };
  const source = value.trim();
  if (
    /^https?:\/\//i.test(source) ||
    /^blob:/i.test(source) ||
    (isUrl && /^\/(?!\/)/.test(source))
  )
    return { mediaType, source };

  const dataUrl = /^data:([^,]*),([\s\S]*)$/i.exec(source);
  let base64 = source;
  if (dataUrl) {
    const embeddedType = mimeType(dataUrl[1]);
    // A concrete data URI type is more reliable than a wildcard tool annotation.
    if (embeddedType && !embeddedType.endsWith('/*')) mediaType = embeddedType;
    if (!/;base64(?:;|$)/i.test(dataUrl[1]))
      return { mediaType, source: embeddedType ? source : undefined };
    base64 = dataUrl[2];
  } else if (isUrl) return { mediaType };

  base64 = base64.replace(/\s/g, '');
  if (
    !base64 ||
    !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64) ||
    base64.length % 4 === 1
  )
    return { mediaType };
  if (mediaType === 'image/*' || mediaType === 'application/octet-stream')
    mediaType = imageType(base64, filename) ?? mediaType;
  return { mediaType, source: `data:${mediaType};base64,${base64}` };
}

export function readFileBlocks(
  output: unknown,
  path?: string,
): ReadFileBlock[] {
  function visit(value: unknown, depth: number): ReadFileBlock[] {
    if (typeof value === 'string') return [{ type: 'text', text: value }];
    if (depth > 8) return [{ type: 'unknown', value }];
    if (Array.isArray(value))
      return value.flatMap((part) => visit(part, depth + 1));
    if (!value || typeof value !== 'object')
      return [{ type: 'unknown', value }];
    const part = value as Record<string, unknown>;
    if (part.type === 'content' && Array.isArray(part.value))
      return visit(part.value, depth + 1);
    if (Array.isArray(part.content)) return visit(part.content, depth + 1);
    if (part.type === 'json') return visit(part.value, depth + 1);
    if (part.type === 'text') {
      const text = typeof part.text === 'string' ? part.text : part.value;
      if (typeof text === 'string') return [{ type: 'text', text }];
    }
    const declared = part.mediaType ?? part.mimeType;
    if (
      typeof declared === 'string' ||
      [
        'image',
        'image-data',
        'image-url',
        'file',
        'file-data',
        'file-url',
        'media',
      ].includes(String(part.type))
    ) {
      const filename = typeof part.filename === 'string' ? part.filename : path;
      const data = part.url ?? part.data ?? part.image;
      const mediaType =
        declared ??
        (String(part.type).startsWith('image') ? 'image/*' : undefined);
      const media: ReadFileBlock = {
        type: 'media',
        filename,
        ...resolveMediaSource(
          data,
          mediaType,
          filename,
          typeof part.url === 'string',
        ),
      };
      return typeof part.text === 'string'
        ? [{ type: 'text', text: part.text }, media]
        : [media];
    }
    return [{ type: 'unknown', value }];
  }
  return output === undefined ? [] : visit(output, 0);
}

export function splitReadFileText(text: string) {
  const newline = text.indexOf('\n');
  if (newline < 0) return { content: text };
  const header = text.slice(0, newline);
  // Preserve the tool's source line numbers and any truncation notices verbatim.
  if (
    /^.+ \((?:lines \d+-\d+ of \d+, )?\d+ bytes(?:, (?:base64|hex|binary|utf-?8))?\)\r?$/.test(
      header,
    )
  )
    return { header, content: text.slice(newline + 1) };
  return { content: text };
}
