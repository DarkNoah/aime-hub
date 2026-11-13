import { useTranslation } from 'react-i18next';
import type { ComponentProps } from 'react';
import { HardDrive } from 'lucide-react';
import {
  FileTree as ElementsFileTree,
  FileTreeFile,
  FileTreeFolder,
} from '@/components/ai-elements/file-tree';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EntryActions, type EntryAction } from './entry-actions';
import { parentPath } from './state';
import type { FileManagerState } from './use-file-manager';

export type FileTreeState = Pick<
  FileManagerState,
  | 'directories'
  | 'expanded'
  | 'selected'
  | 'changeExpanded'
  | 'toggle'
  | 'openFile'
  | 'loadDirectory'
  | 'scope'
> & { client: Pick<FileManagerState['client'], 'raw'> };

function OptionalEntryActions({
  onAction,
  onUpload,
  children,
  ...props
}: Omit<ComponentProps<typeof EntryActions>, 'onAction' | 'onUpload'> & {
  onAction?: (action: EntryAction) => void;
  onUpload?: (directory: string) => void;
}) {
  return onAction && onUpload ? (
    <EntryActions {...props} onAction={onAction} onUpload={onUpload}>
      {children}
    </EntryActions>
  ) : (
    children
  );
}

export function FileTree({
  state,
  onAction,
  onUpload,
  dropTarget = null,
}: {
  state: FileTreeState;
  onAction?: (action: EntryAction) => void;
  onUpload?: (directory: string) => void;
  dropTarget?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <ElementsFileTree
      aria-label={t('files.title')}
      className="rounded-none border-0 bg-transparent font-sans text-xs"
      expanded={state.expanded}
      selectedPath={state.selected}
      onExpandedChange={state.changeExpanded}
      onSelect={(path) => {
        const entry = state.directories[parentPath(path)]?.entries?.find(
          (entry) => entry.path === path,
        );
        if (entry?.kind === 'directory') state.toggle(path);
        else state.openFile(path);
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        const node = target.closest<HTMLElement>('[data-file-node]');
        if (
          !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
          !node ||
          target.closest('[aria-haspopup="menu"], [role="menu"]')
        )
          return;
        const nodes = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            '[data-file-node]',
          ),
        ].filter((node) => node.getClientRects().length);
        const index = nodes.indexOf(node);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? nodes.length - 1
              : index + (event.key === 'ArrowDown' ? 1 : -1);
        nodes[Math.max(0, Math.min(nodes.length - 1, next))]?.focus();
        event.preventDefault();
      }}
    >
      <Directory
        path=""
        state={state}
        onAction={onAction}
        onUpload={onUpload}
        dropTarget={dropTarget}
        depth={0}
      />
    </ElementsFileTree>
  );
}

function Directory({
  path,
  state,
  onAction,
  onUpload,
  dropTarget,
  depth,
}: {
  path: string;
  state: FileTreeState;
  onAction?: (action: EntryAction) => void;
  onUpload?: (directory: string) => void;
  dropTarget: string | null;
  depth: number;
}) {
  const { t } = useTranslation();
  const directory = state.directories[path];
  if (!directory || (directory.loading && !directory.entries))
    return (
      <div
        role="status"
        aria-label={t('files.loading')}
        className="space-y-2 p-2 motion-safe:animate-pulse"
      >
        <div className="h-5 w-3/4 rounded bg-muted" />
        <div className="h-5 w-1/2 rounded bg-muted" />
      </div>
    );
  return (
    <>
      {directory.error && (
        <div role="alert" className="p-2 text-xs text-destructive">
          {t(directory.error)}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void state.loadDirectory(path)}
          >
            {t('files.retry')}
          </Button>
        </div>
      )}
      {!directory.error && !directory.entries?.length && (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          {t(path ? 'files.emptyFolder' : 'files.empty')}
        </p>
      )}
      {directory.entries?.map((entry) => {
        const folder = entry.kind === 'directory';
        const open = state.expanded.has(entry.path);
        const nodeProps = {
          'data-file-node': true,
          'data-path': entry.path,
          'aria-label': entry.isMount
            ? `/${entry.path} · ${t('files.mountPoint')}`
            : entry.name,
          'aria-level': depth + 1,
          title: entry.isMount
            ? `/${entry.path} · ${t('files.mountProtected')}`
            : entry.path,
          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
            const target = event.target as HTMLElement;
            if (
              target.closest('[data-file-node]') !== event.currentTarget ||
              target.closest('[aria-haspopup="menu"], [role="menu"]')
            )
              return;
            if (
              (event.key === 'Enter' || event.key === ' ') &&
              target === event.currentTarget
            ) {
              event.preventDefault();
              if (folder) state.toggle(entry.path);
              else state.openFile(entry.path);
            }
            if (event.key === 'ArrowRight' && folder && !open) {
              event.preventDefault();
              state.toggle(entry.path);
            }
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              if (folder && open) state.toggle(entry.path);
              else {
                const nodes = event.currentTarget
                  .closest('[role=tree]')
                  ?.querySelectorAll<HTMLElement>('[data-file-node]');
                [...(nodes ?? [])]
                  .find((node) => node.dataset.path === path)
                  ?.focus();
              }
            }
          },
        };
        return folder ? (
          <FileTreeFolder
            key={entry.path}
            path={entry.path}
            name={entry.isMount ? `${entry.path}` : entry.name}
            className="min-w-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            renderRow={(row) => (
              <OptionalEntryActions
                entry={entry}
                scope={state.scope}
                onAction={onAction}
                onUpload={onUpload}
                dropTarget={dropTarget === entry.path}
              >
                {row}
                {entry.isMount && (
                  <Badge
                    variant="secondary"
                    className="shrink-0 gap-1 px-1.5 py-0 text-[10px]"
                    title={t('files.mountProtected')}
                  >
                    <HardDrive className="size-3" />
                    {/* {t('files.mountPoint')} */}
                  </Badge>
                )}
              </OptionalEntryActions>
            )}
            {...nodeProps}
          >
            {open && (
              <div data-upload-directory={entry.path}>
                <Directory
                  path={entry.path}
                  state={state}
                  onAction={onAction}
                  onUpload={onUpload}
                  dropTarget={dropTarget}
                  depth={depth + 1}
                />
              </div>
            )}
          </FileTreeFolder>
        ) : (
          <OptionalEntryActions
            key={entry.path}
            entry={entry}
            scope={state.scope}
            downloadUrl={state.client.raw(entry.path, true)}
            onAction={onAction}
            onUpload={onUpload}
          >
            <FileTreeFile
              path={entry.path}
              name={entry.name}
              className="h-8 min-w-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              {...nodeProps}
            />
          </OptionalEntryActions>
        );
      })}
      {directory.truncated && (
        <p className="p-2 text-xs text-muted-foreground">
          {t('files.directoryLimit')}
        </p>
      )}
    </>
  );
}
