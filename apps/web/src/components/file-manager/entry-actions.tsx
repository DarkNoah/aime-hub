import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FilePlus2,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { FileEntry } from '@aime/shared/files';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type EntryAction = {
  operation: 'createFile' | 'createFolder' | 'rename' | 'delete';
  entry: FileEntry;
};

export function EntryActions({
  entry,
  children,
  onAction,
}: {
  entry: FileEntry;
  children: ReactNode;
  onAction: (action: EntryAction) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div
        className="group/entry flex min-w-0 items-center rounded-md hover:bg-muted/80"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {children}
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-1 size-7 shrink-0 text-muted-foreground"
            aria-label={t('files.actions', {
              name: entry.name || t('files.root'),
            })}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end">
        {entry.kind === 'directory' && (
          <>
            <DropdownMenuItem
              onSelect={() => onAction({ operation: 'createFile', entry })}
            >
              <FilePlus2 />
              {t('files.createFile')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onAction({ operation: 'createFolder', entry })}
            >
              <FolderPlus />
              {t('files.createFolder')}
            </DropdownMenuItem>
          </>
        )}
        {entry.path && (
          <>
            <DropdownMenuItem
              onSelect={() => onAction({ operation: 'rename', entry })}
            >
              <Pencil />
              {t('files.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onAction({ operation: 'delete', entry })}
            >
              <Trash2 />
              {t('files.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
