import { useState, type DragEvent, type ReactNode } from 'react';
import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';

function dropDirectory(
  target: EventTarget | null,
  container: HTMLElement,
): string {
  const element =
    target instanceof Element
      ? target.closest<HTMLElement>('[data-upload-directory]')
      : null;
  return element && container.contains(element)
    ? (element.dataset.uploadDirectory ?? '')
    : '';
}

export function UploadDropZone({
  children,
  target,
  onTargetChange,
  onFiles,
  onChoose,
}: {
  children: ReactNode;
  target: string | null;
  onTargetChange: (target: string | null) => void;
  onFiles: (files: File[], directory: string) => void;
  onChoose: (directory: string) => void;
}) {
  const { t } = useTranslation();
  const [menuDirectory, setMenuDirectory] = useState('');
  const dragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    onTargetChange(dropDirectory(event.target, event.currentTarget));
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onContextMenu={(event) =>
            setMenuDirectory(dropDirectory(event.target, event.currentTarget))
          }
          className={cn(
            'relative flex min-h-0 flex-1 flex-col',
            target !== null && 'ring-2 ring-inset ring-primary',
          )}
          onDragEnter={dragOver}
          onDragOver={dragOver}
          onDragLeave={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            )
              onTargetChange(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onTargetChange(null);
            const directory = dropDirectory(event.target, event.currentTarget);
            const items = Array.from(event.dataTransfer.items).filter(
              (item) => item.kind === 'file',
            );
            const files: File[] = [];
            let folders = false;
            for (const item of items) {
              if (item.webkitGetAsEntry?.()?.isDirectory) {
                folders = true;
                continue;
              }
              const file = item.getAsFile();
              if (file) files.push(file);
            }
            if (folders) toast.error(t('files.uploadFilesOnly'));
            const selected = items.length
              ? files
              : Array.from(event.dataTransfer.files);
            if (selected.length) onFiles(selected, directory);
          }}
        >
          {children}
          {target !== null && (
            <div
              className="pointer-events-none absolute right-2 bottom-2 left-2 flex items-center gap-2 rounded-md border border-primary/30 bg-background/95 px-3 py-2 text-xs text-primary shadow-sm"
              role="status"
            >
              <Upload className="size-4 shrink-0" />
              <span className="min-w-0 truncate">
                {t('files.dropUpload', {
                  path: target ? `/${target}` : t('files.root'),
                })}
              </span>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onChoose(menuDirectory)}>
          <Upload />
          {t('files.upload')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
