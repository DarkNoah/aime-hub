import { extname } from 'node:path';

const formats: Record<
  string,
  {
    mimeType: string;
    kind: 'image' | 'pdf' | 'document' | 'audio' | 'video' | 'text';
  }
> = {
  '.pdf': { mimeType: 'application/pdf', kind: 'pdf' },
  '.png': { mimeType: 'image/png', kind: 'image' },
  '.jpg': { mimeType: 'image/jpeg', kind: 'image' },
  '.jpeg': { mimeType: 'image/jpeg', kind: 'image' },
  '.gif': { mimeType: 'image/gif', kind: 'image' },
  '.webp': { mimeType: 'image/webp', kind: 'image' },
  '.bmp': { mimeType: 'image/bmp', kind: 'image' },
  '.tif': { mimeType: 'image/tiff', kind: 'image' },
  '.tiff': { mimeType: 'image/tiff', kind: 'image' },
  '.jp2': { mimeType: 'image/jp2', kind: 'image' },
  '.docx': {
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
  },
  '.xlsx': {
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'document',
  },
  '.pptx': {
    mimeType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'document',
  },
  '.odt': {
    mimeType: 'application/vnd.oasis.opendocument.text',
    kind: 'document',
  },
  '.ods': {
    mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
    kind: 'document',
  },
  '.odp': {
    mimeType: 'application/vnd.oasis.opendocument.presentation',
    kind: 'document',
  },
  '.odg': {
    mimeType: 'application/vnd.oasis.opendocument.graphics',
    kind: 'document',
  },
  '.rtf': { mimeType: 'application/rtf', kind: 'document' },
  '.epub': { mimeType: 'application/epub+zip', kind: 'document' },
  '.html': { mimeType: 'text/html', kind: 'text' },
  '.htm': { mimeType: 'text/html', kind: 'text' },
  '.mp3': { mimeType: 'audio/mpeg', kind: 'audio' },
  '.wav': { mimeType: 'audio/wav', kind: 'audio' },
  '.m4a': { mimeType: 'audio/mp4', kind: 'audio' },
  '.ogg': { mimeType: 'audio/ogg', kind: 'audio' },
  '.oga': { mimeType: 'audio/ogg', kind: 'audio' },
  '.aac': { mimeType: 'audio/aac', kind: 'audio' },
  '.flac': { mimeType: 'audio/flac', kind: 'audio' },
  '.opus': { mimeType: 'audio/opus', kind: 'audio' },
  '.mp4': { mimeType: 'video/mp4', kind: 'video' },
  '.mov': { mimeType: 'video/quicktime', kind: 'video' },
  '.avi': { mimeType: 'video/x-msvideo', kind: 'video' },
  '.mkv': { mimeType: 'video/x-matroska', kind: 'video' },
  '.webm': { mimeType: 'video/webm', kind: 'video' },
  '.m4v': { mimeType: 'video/x-m4v', kind: 'video' },
};

export const legacyOfficeExtensions = new Set(['.doc', '.xls', '.ppt']);

export function fileContentFormat(fileName: string) {
  return formats[extname(fileName).toLowerCase()];
}

export function fileNameForMimeType(fileName: string, mimeType?: string) {
  const mime = mimeType?.split(';')[0]?.trim().toLowerCase();
  const extension = Object.keys(formats).find(
    (key) => formats[key]!.mimeType === mime,
  );
  return extension && fileContentFormat(fileName)?.mimeType !== mime
    ? `${fileName}${extension}`
    : fileName;
}
