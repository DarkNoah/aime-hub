import { lazy, Suspense, useMemo, useState } from 'react';
import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import {
  Attachment,
  AttachmentPreview,
  Attachments,
} from '@/components/ai-elements/attachments';
import { PreviewImage } from '@/components/image-viewer/preview-image';
import { useWorkspaceFile } from '@/components/file-manager/context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AudioClip } from '@/components/audio/audio-clip';
import { getToolAttachments, type ToolAttachment } from './tool-attachments';

const ImageLightbox = lazy(
  () => import('@/components/image-viewer/image-lightbox'),
);
const previewLimit = 6;

export function ChatToolAttachments({
  tools,
  threadId,
}: {
  tools: (ToolUIPart | DynamicToolUIPart)[];
  threadId?: string;
}) {
  const { t } = useTranslation();
  const openFile = useWorkspaceFile();
  const attachments = useMemo(
    () => getToolAttachments(tools, threadId),
    [tools, threadId],
  );
  const [expanded, setExpanded] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const images = useMemo(
    () => attachments.filter((file) => file.mediaType.startsWith('image/')),
    [attachments],
  );
  const slides = useMemo(
    () =>
      images.map((file) => ({
        src: file.url,
        name: file.filename || t('chat.readFile.attachment'),
        downloadUrl: file.url,
      })),
    [images, t],
  );
  const previewIndex = images.findIndex((file) => file.id === previewId);
  const preview = slides[previewIndex];
  const grouped = images.length > 1;
  const otherAttachments = grouped
    ? attachments.filter((file) => !file.mediaType.startsWith('image/'))
    : attachments;
  if (attachments.length === 0) return null;

  const renderAttachment = (file: ToolAttachment, gallery = false) => {
    const name = file.filename || t('chat.readFile.attachment');
    const kind = file.mediaType.split('/', 1)[0];
    const previewLabel = t('files.openPreview', {
      path: file.workspacePath || name,
    });
    const canPreview = !!openFile && !!file.workspacePath?.trim();
    const openPreview = () => {
      if (file.workspacePath) openFile?.(file.workspacePath);
    };
    if (kind === 'audio') {
      return (
        <AudioClip
          key={file.id}
          src={file.url}
          filename={name}
          mediaType={file.mediaType}
          onOpen={canPreview ? openPreview : undefined}
          className="w-[26rem] max-w-full"
        />
      );
    }
    return (
      <Attachment
        key={file.id}
        data={file}
        className={cn(
          'h-auto max-w-full border bg-card',
          gallery ? 'w-full min-w-0' : 'w-64',
        )}
      >
        {kind === 'image' ? (
          <PreviewImage
            src={file.url}
            alt={name}
            referrerPolicy="no-referrer"
            containerClassName="w-full rounded-none"
            className={cn(
              'w-full max-h-none rounded-none',
              gallery
                ? 'aspect-[4/3] h-auto bg-muted/40 object-contain'
                : 'h-48 object-cover',
            )}
            onPreview={() => setPreviewId(file.id)}
            onOpen={canPreview ? openPreview : undefined}
          />
        ) : kind === 'video' ? (
          <video
            src={file.url}
            aria-label={name}
            controls
            preload="metadata"
            className="max-h-48 w-full"
          />
        ) : (
          <button
            type="button"
            onClick={openPreview}
            disabled={!canPreview}
            aria-label={previewLabel}
            className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
          >
            <AttachmentPreview className="h-20" />
          </button>
        )}
        {kind !== 'image' && (
          <div className="flex min-w-0 items-center gap-1 border-t px-2 py-1">
            <button
              type="button"
              onClick={openPreview}
              disabled={!canPreview}
              aria-label={previewLabel}
              title={file.workspacePath || name}
              className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-xs text-muted-foreground enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            >
              {name}
            </button>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 text-muted-foreground"
              aria-label={`${t('files.download')}: ${name}`}
              title={t('files.download')}
            >
              <a
                href={file.url}
                download={name}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download className="size-3.5" aria-hidden="true" />
              </a>
            </Button>
          </div>
        )}
      </Attachment>
    );
  };

  return (
    <>
      {grouped && (
        <div
          className="@container w-full max-w-3xl space-y-2"
          data-chat-image-gallery
        >
          <Badge variant="secondary">
            {t('imagePreview.count', { count: images.length })}
          </Badge>
          <Attachments
            variant="grid"
            className={cn(
              'ml-0 grid w-full max-w-full grid-cols-2',
              images.length > 4 && '@[36rem]:grid-cols-3',
            )}
            aria-label={t('imagePreview.gallery')}
          >
            {(expanded ? images : images.slice(0, previewLimit)).map((file) =>
              renderAttachment(file, true),
            )}
          </Attachments>
          {images.length > previewLimit && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {t(expanded ? 'imagePreview.showLess' : 'imagePreview.showAll', {
                count: images.length,
              })}
            </Button>
          )}
        </div>
      )}
      {otherAttachments.length > 0 && (
        <Attachments
          variant="grid"
          className="ml-0 w-full max-w-full"
          aria-label={t('chat.readFile.media')}
        >
          {otherAttachments.map((file) => renderAttachment(file))}
        </Attachments>
      )}
      {preview && (
        <Suspense fallback={null}>
          <ImageLightbox
            src={preview.src}
            name={preview.name}
            downloadUrl={preview.downloadUrl}
            images={slides}
            index={previewIndex}
            referrerPolicy="no-referrer"
            close={() => setPreviewId(null)}
          />
        </Suspense>
      )}
    </>
  );
}
