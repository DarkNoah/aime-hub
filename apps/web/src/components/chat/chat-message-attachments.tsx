import { useTranslation } from 'react-i18next';
import {
  Attachment,
  AttachmentPreview,
  Attachments,
} from '@/components/ai-elements/attachments';
import { filesApi } from '@/components/file-manager/api';
import { useWorkspaceFile } from '@/components/file-manager/context';
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
        // Attachment paths are rooted in the workspace, not the host filesystem.
        const path = attachment.workspacePath?.replace(/^\//, '');
        const url =
          attachment.url ||
          (threadId && path ? filesApi.raw(threadId, path) : '');
        const name = attachment.filename || t('chat.readFile.attachment');
        const canPreview = !!(path && openFile);
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
              disabled={!canPreview}
              aria-label={t('files.openPreview', { path: name })}
              className="block size-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
            >
              <AttachmentPreview />
            </button>
          </Attachment>
        );
      })}
    </Attachments>
  );
}
