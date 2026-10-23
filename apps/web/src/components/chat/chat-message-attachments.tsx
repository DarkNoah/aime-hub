import { lazy, Suspense, useState } from 'react';
import { Download, Expand, Folder } from 'lucide-react';
import { attachmentFileReference } from '@aime/shared/chat-attachments';
import { workspaceReferencePath } from '@aime/shared/files';
import { useTranslation } from 'react-i18next';
import {
  Attachment,
  AttachmentPreview,
  Attachments,
} from '@/components/ai-elements/attachments';
import { filesApi } from '@/components/file-manager/api';
import { useWorkspaceFile } from '@/components/file-manager/context';
import { Button } from '@/components/ui/button';
import { ImageEditButton } from '@/components/image-viewer/image-edit-button';
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
        const target = attachment.workspacePath
          ? attachmentFileReference(attachment.workspacePath)
          : undefined;
        const path = target && workspaceReferencePath(target);
        const directory = target?.kind === 'directory';
        const url =
          attachment.url ||
          (threadId && target && !directory
            ? filesApi.raw(threadId, target.path, false, target.scope)
            : '');
        const name = attachment.filename || t('chat.readFile.attachment');
        const canOpenFile = !!(path && openFile);
        const canPreviewImage =
          !directory && attachment.mediaType.startsWith('image/') && !!url;
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
              <AttachmentPreview
                fallbackIcon={
                  directory ? <Folder className="size-8" /> : undefined
                }
              />
            </button>
            <div className="absolute right-1 bottom-1 flex items-center gap-1">
              {canPreviewImage && (
                <>
                  <ImageEditButton
                    src={url}
                    name={name}
                    variant="outline"
                    size="icon-xs"
                    className="bg-background/90"
                  />
                  <Button
                    asChild
                    variant="outline"
                    size="icon-xs"
                    className="bg-background/90 shadow-none"
                  >
                    <a
                      href={url}
                      download={name}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${t('files.download')}: ${name}`}
                      title={t('files.download')}
                    >
                      <Download className="size-3.5" aria-hidden="true" />
                    </a>
                  </Button>
                </>
              )}
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="bg-background/90 shadow-none"
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
            </div>
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
