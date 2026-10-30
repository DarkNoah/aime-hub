import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FilePreview, FileScope } from '@aime/shared/files';
import { fileErrorKey, filesApi } from '@/components/file-manager/api';
import { FilePreviewContent } from '@/components/file-manager/preview/file-preview-content';
import { PreviewLoading } from '@/components/file-manager/preview/preview-loading';

/** Read-only file preview. Mount with a thread/path key to isolate pending reads. */
export function ThreadFilePreview({
  threadId,
  path,
}: {
  threadId: string;
  path: string;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{
    data: FilePreview;
    scope: FileScope;
  } | null>(null);
  const [error, setError] = useState<
    ReturnType<typeof fileErrorKey> | 'chat.preview.fileOnly' | ''
  >('');
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
        if (target.kind !== 'file') {
          setError('chat.preview.fileOnly');
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
  return (
    <FilePreviewContent
      data={result.data}
      url={filesApi.raw(threadId, result.data.path, false, result.scope)}
      downloadUrl={filesApi.raw(threadId, result.data.path, true, result.scope)}
    />
  );
}
