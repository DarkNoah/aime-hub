import { Expand, Folder } from 'lucide-react';
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
import { PreviewImage } from '@/components/image-viewer/preview-image';
import type { MessageAttachment } from './message-attachments';

export function ChatMessageAttachments({
  attachments,
  threadId,
}: {
  attachments: MessageAttachment[];
  threadId?: string;
}) {
  const { t } = useTranslation();
  const openFile = useWorkspaceFile();
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
        const previewLabel = t('files.openPreview', { path: name });
        if (canPreviewImage) {
          return (
            <Attachment
              key={`${attachment.id}:${index}`}
              data={{ ...attachment, url }}
              title={name}
              className="h-32 w-40 border bg-background"
            >
              <PreviewImage
                src={url}
                alt={name}
                downloadUrl={
                  threadId && target
                    ? filesApi.raw(threadId, target.path, true, target.scope)
                    : url
                }
                containerClassName="size-full"
                className="h-32 w-full rounded-none object-cover"
                onOpen={path && openFile ? () => openFile(path) : undefined}
              />
            </Attachment>
          );
        }
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
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="bg-background/90 shadow-none"
                aria-label={previewLabel}
                title={previewLabel}
                disabled={!canOpenFile}
                onClick={(event) => {
                  event.stopPropagation();
                  if (path) openFile?.(path);
                }}
              >
                <Expand className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </Attachment>
        );
      })}
    </Attachments>
  );
}
