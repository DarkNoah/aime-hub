import { useMemo } from 'react';
import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import {
  Attachment,
  AttachmentPreview,
  Attachments,
} from '@/components/ai-elements/attachments';
import { PreviewImage } from '@/components/image-viewer/preview-image';
import { ImageEditButton } from '@/components/image-viewer/image-edit-button';
import { useWorkspaceFile } from '@/components/file-manager/context';
import { Button } from '@/components/ui/button';
import { AudioClip } from '@/components/audio/audio-clip';
import { getToolAttachments } from './tool-attachments';

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
  if (attachments.length === 0) return null;

  return (
    <Attachments
      variant="grid"
      className="ml-0 w-full max-w-full"
      aria-label={t('chat.readFile.media')}
    >
      {attachments.map((file) => {
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
            className="h-auto w-64 max-w-full border bg-card"
          >
            {kind === 'image' ? (
              <PreviewImage
                src={file.url}
                alt={name}
                referrerPolicy="no-referrer"
                containerClassName="w-full rounded-none"
                className="h-48 w-full max-h-none rounded-none object-cover"
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
              {kind === 'image' && (
                <ImageEditButton
                  src={file.url}
                  name={name}
                  referrerPolicy="no-referrer"
                  className="size-6"
                />
              )}
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
          </Attachment>
        );
      })}
    </Attachments>
  );
}
