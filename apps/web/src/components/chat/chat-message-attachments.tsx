import { lazy, Suspense, useState } from 'react';
import { Expand } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Attachment,
  AttachmentPreview,
  Attachments,
} from '@/components/ai-elements/attachments';
import { filesApi } from '@/components/file-manager/api';
import { useWorkspaceFile } from '@/components/file-manager/context';
import { Button } from '@/components/ui/button';
import type { MessageAttachment } from './message-attachments';

const ImageLightbox = lazy(
  () => import('@/components/image-viewer/image-lightbox'),
);

export function ChatMessageAttachments({
  attachments,
  threadId,
}: {
  attachments: MessageAttachment[];
  threadId?: string;
}) {
  const { t } = useTranslation();
  const openFile = useWorkspaceFile();
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(
    null,
  );
  if (!attachments.length) return null;
  return (
    <Attachments
      variant="grid"
      className="max-w-full min-w-0 justify-end"
      aria-label={t('chat.readFile.media')}
      data-chat-message-attachments
    >
      {attachments.map((attachment, index) => {
        // Attachment paths are rooted in the workspace, not the host filesystem.
        const path = attachment.workspacePath?.replace(/^\//, '');
        const url =
          attachment.url ||
          (threadId && path ? filesApi.raw(threadId, path) : '');
        const name = attachment.filename || t('chat.readFile.attachment');
        const canOpenFile = !!(path && openFile);
        const canPreviewImage =
          attachment.mediaType.startsWith('image/') && !!url;
        const previewLabel = canPreviewImage
          ? t('imagePreview.open', { name })
          : t('files.openPreview', { path: name });
        return (
          <Attachment
            key={`${attachment.id}:${index}`}
            data={{ ...attachment, url }}
            title={name}
            className="border bg-background"
          >
            <button
              type="button"
              onClick={() => path && openFile?.(path)}
              disabled={!canOpenFile}
              aria-label={t('files.openPreview', { path: name })}
              className="block size-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
            >
              <AttachmentPreview />
            </button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="absolute right-1 bottom-1 bg-background/90 shadow-none"
              aria-label={previewLabel}
              title={previewLabel}
              aria-haspopup={canPreviewImage ? 'dialog' : undefined}
              disabled={!canPreviewImage && !canOpenFile}
              onClick={(event) => {
                event.stopPropagation();
                if (canPreviewImage) setPreview({ url, name });
                else if (path) openFile?.(path);
              }}
            >
              <Expand className="size-3.5" aria-hidden="true" />
            </Button>
          </Attachment>
        );
      })}
      {preview && (
        <Suspense fallback={null}>
          <ImageLightbox
            src={preview.url}
            name={preview.name}
            downloadUrl={preview.url}
            close={() => setPreview(null)}
          />
        </Suspense>
      )}
    </Attachments>
  );
}
