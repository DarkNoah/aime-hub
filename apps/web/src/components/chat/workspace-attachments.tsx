import { useContext, useEffect, useState, type ReactNode } from 'react';
import { FileText, Folder, Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { WorkspaceFileReference } from '@aime/shared/files';
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from '@/components/ai-elements/attachments';
import { WorkspaceDragContext } from '@/components/file-manager/drag-context';
import {
  readWorkspaceFileDrag,
  WORKSPACE_FILE_DRAG_TYPE,
  workspaceReferencePath,
} from '@/components/file-manager/drag-data';
import { cn } from '@/lib/utils';

export function WorkspaceFileDropZone({
  children,
  disabled,
  onAdd,
}: {
  children: ReactNode;
  disabled: boolean;
  onAdd: (reference: WorkspaceFileReference) => void;
}) {
  const { t } = useTranslation();
  const workspaceId = useContext(WorkspaceDragContext);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const reset = () => setDragging(false);
    document.addEventListener('dragend', reset);
    document.addEventListener('drop', reset);
    return () => {
      document.removeEventListener('dragend', reset);
      document.removeEventListener('drop', reset);
    };
  }, [dragging]);
  const active = dragging && !disabled && !!workspaceId;
  return (
    <div
      className={cn(
        'relative rounded-2xl',
        active && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
      onDragOverCapture={(event) => {
        if (!event.dataTransfer.types.includes(WORKSPACE_FILE_DRAG_TYPE))
          return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect =
          disabled || !workspaceId ? 'none' : 'copy';
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDragging(false);
      }}
      onDropCapture={(event) => {
        if (!event.dataTransfer.types.includes(WORKSPACE_FILE_DRAG_TYPE))
          return;
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        if (disabled || !workspaceId) return;
        const reference = readWorkspaceFileDrag(
          event.dataTransfer,
          workspaceId,
        );
        if (!reference) {
          toast.error(t('chat.workspaceFiles.invalidDrop'));
          return;
        }
        onAdd(reference);
        event.currentTarget.querySelector('textarea')?.focus();
      }}
    >
      {children}
      {active && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-2xl bg-background/90 p-3 text-sm font-medium text-primary"
        >
          <Paperclip className="size-4 shrink-0" aria-hidden="true" />
          {t('chat.workspaceFiles.drop')}
        </div>
      )}
    </div>
  );
}

export function WorkspaceAttachments({
  references,
  onRemove,
  disabled,
}: {
  references: WorkspaceFileReference[];
  onRemove: (reference: WorkspaceFileReference) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  if (!references.length) return null;
  return (
    <Attachments
      variant="inline"
      className="w-full min-w-0 px-3 pt-3"
      aria-label={t('chat.workspaceFiles.title')}
    >
      {references.map((reference) => {
        const path = workspaceReferencePath(reference);
        const name = reference.path.split('/').at(-1)!;
        const Icon = reference.kind === 'directory' ? Folder : FileText;
        return (
          <Attachment
            key={path}
            data={{
              id: path,
              type: 'source-document',
              sourceId: path,
              title: name,
              mediaType: 'text/plain',
            }}
            title={path}
            tabIndex={0}
            onRemove={() => onRemove(reference)}
            className="max-w-full min-w-0"
          >
            <AttachmentPreview fallbackIcon={<Icon className="size-3" />} />
            <AttachmentInfo className="max-w-48" />
            <AttachmentRemove
              disabled={disabled}
              label={t('assets.remove', { name })}
              className="shrink-0 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            />
          </Attachment>
        );
      })}
    </Attachments>
  );
}
