import { useEffect, useState } from 'react';
import type { FilePreview as Preview } from '@aime/shared/files';
import { Download, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fileErrorKey } from './api';
import { FilePreviewContent } from './preview/file-preview-content';
import { PreviewLoading } from './preview/preview-loading';
import type { WorkspaceFileClient } from './workspace-client';

export function FilePreview({
  client,
  path,
  line,
  revision,
}: {
  client: WorkspaceFileClient;
  path: string;
  line?: number;
  revision: number;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<(Preview & { url: string }) | null>(null);
  const [error, setError] = useState<ReturnType<typeof fileErrorKey> | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const rawUrl = client.raw(path);
    void client
      .preview(path, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData({
            ...result,
            url: `${rawUrl}&v=${encodeURIComponent(result.modifiedAt)}&retry=${retry}`,
          });
          setError(null);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(fileErrorKey(cause));
      });
    return () => controller.abort();
  }, [client, path, revision, retry]);
  if (error)
    return (
      <div role="alert" className="p-5 text-sm">
        <p>{t(error)}</p>
        <Button
          className="mt-3"
          variant="outline"
          onClick={() => setRetry((value) => value + 1)}
        >
          {t('files.retry')}
        </Button>
      </div>
    );
  if (!data) return <PreviewLoading />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b px-3">
        <span
          title={path}
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        >
          {path}
        </span>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {data.size < 1024
            ? `${data.size} B`
            : data.size < 1024 * 1024
              ? `${(data.size / 1024).toFixed(1)} KB`
              : `${(data.size / 1024 / 1024).toFixed(1)} MB`}
        </Badge>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('files.refreshPreview')}
          title={t('files.refreshPreview')}
          onClick={() => setRetry((value) => value + 1)}
        >
          <RotateCw className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon-sm" asChild>
          <a
            href={client.raw(path, true)}
            download
            aria-label={t('files.download')}
            title={t('files.download')}
          >
            <Download className="size-3.5" />
          </a>
        </Button>
      </div>
      {data.truncated && (
        <p className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t('files.previewLimit')}
        </p>
      )}
      <div className="min-h-0 min-w-0 flex-1">
        <FilePreviewContent
          key={path}
          data={data}
          url={data.url}
          downloadUrl={client.raw(path, true)}
          line={line}
        />
      </div>
    </div>
  );
}
