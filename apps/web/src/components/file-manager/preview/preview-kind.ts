import type { FilePreview } from '@aime/shared/files';

export type PreviewKind = FilePreview['kind'] | 'html' | 'markdown';

export function getPreviewKind(data: FilePreview): PreviewKind {
  // Only render files the server has confirmed contain readable text.
  if (data.kind !== 'text') return data.kind;
  const mime = data.mime.split(';', 1)[0].trim().toLowerCase();
  if (
    /\.(md|markdown)$/i.test(data.path) ||
    mime === 'text/markdown' ||
    mime === 'text/x-markdown'
  )
    return 'markdown';
  return /\.html?$/i.test(data.path) || mime === 'text/html' ? 'html' : 'text';
}
