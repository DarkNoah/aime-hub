import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { File, Folder } from 'lucide-react';
import type { FileListing, FilePreview, FileScope } from '@aime/shared/files';
import { fileErrorKey, filesApi } from '@/components/file-manager/api';
import { useScopedWorkspaceFile } from '@/components/file-manager/context';
import { FilePreviewContent } from '@/components/file-manager/preview/file-preview-content';
import { PreviewLoading } from '@/components/file-manager/preview/preview-loading';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

/** Read-only file preview. Mount with a thread/path key to isolate pending reads. */
export function ThreadFilePreview({
  threadId,
  path,
  line,
}: {
  threadId: string;
  path: string;
  line?: number;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<
    | { data: FilePreview; scope: FileScope }
    | { listing: FileListing; scope: FileScope }
    | null
  >(null);
  const openLink = useScopedWorkspaceFile(result?.scope ?? 'thread');
  const [error, setError] = useState<ReturnType<typeof fileErrorKey> | ''>('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const target = await filesApi.resolve(
          threadId,
          path,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (target.kind === 'directory') {
          const listing = await filesApi.list(
            threadId,
            target.path,
            controller.signal,
            target.scope,
          );
          if (!controller.signal.aborted)
            setResult({ listing, scope: target.scope });
          return;
        }
        const data = await filesApi.preview(
          threadId,
          target.path,
          controller.signal,
          target.scope,
        );
        if (!controller.signal.aborted)
          setResult({ data, scope: target.scope });
      } catch (cause) {
        if (!controller.signal.aborted) setError(fileErrorKey(cause));
      }
    }
    void load();
    return () => controller.abort();
  }, [threadId, path]);
  if (error)
    return (
      <p role="alert" className="p-4 text-sm text-muted-foreground">
        {t(error)}
      </p>
    );
  if (!result) return <PreviewLoading />;
  if ('listing' in result) {
    const { entries, truncated } = result.listing;
    return (
      <ScrollArea className="h-full p-3">
        {entries.map((entry) => {
          const Icon = entry.kind === 'directory' ? Folder : File;
          return (
            <Button
              key={entry.path}
              variant="ghost"
              className="flex w-full justify-start"
              title={entry.path}
              disabled={!openLink}
              onClick={() => openLink?.(entry.path, entry.kind)}
            >
              <Icon className="size-4" aria-hidden="true" />
              <span className="truncate">{entry.name}</span>
            </Button>
          );
        })}
        {(!entries.length || truncated) && (
          <p className="p-2 text-sm text-muted-foreground">
            {t(truncated ? 'files.directoryLimit' : 'files.emptyFolder')}
          </p>
        )}
      </ScrollArea>
    );
  }
  return (
    <FilePreviewContent
      data={result.data}
      line={line}
      source={line !== undefined}
      url={filesApi.raw(threadId, result.data.path, false, result.scope)}
      downloadUrl={filesApi.raw(threadId, result.data.path, true, result.scope)}
      onOpenLink={openLink}
      getFileUrl={(path) => filesApi.raw(threadId, path, false, result.scope)}
    />
  );
}
