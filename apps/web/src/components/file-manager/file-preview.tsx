import { lazy, Suspense, useEffect, useState } from 'react';
import type { FilePreview as Preview } from '@aime/shared/files';
import { Download, File, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { filesApi, fileErrorKey } from './api';

const TextPreview = lazy(() => import('./text-preview'));

export function FilePreview({
  threadId,
  path,
  line,
  revision,
}: {
  threadId: string;
  path: string;
  line?: number;
  revision: number;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<Preview | null>(null);
  const [error, setError] = useState<ReturnType<typeof fileErrorKey> | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  const [mediaError, setMediaError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void filesApi
      .preview(threadId, path, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setError(null);
          setMediaError(false);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(fileErrorKey(cause));
      });
    return () => controller.abort();
  }, [threadId, path, revision, retry]);
  const url = `${filesApi.raw(threadId, path)}&v=${encodeURIComponent(data?.modifiedAt ?? '')}`;
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
            href={filesApi.raw(threadId, path, true)}
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
      <div className="min-h-0 flex-1">
        {data.kind === 'text' ? (
          <Suspense fallback={<PreviewLoading />}>
            <TextPreview text={data.text ?? ''} path={path} line={line} />
          </Suspense>
        ) : (
          <ScrollArea
            className="h-full"
            viewportProps={{
              className:
                '[&>div]:!flex [&>div]:min-h-full [&>div]:items-center [&>div]:justify-center',
            }}
          >
            <div className="w-full min-w-0 p-5 text-center">
              {mediaError ? (
                <p role="alert" className="mb-4 text-sm text-muted-foreground">
                  {t('files.mediaError')}
                </p>
              ) : data.kind === 'image' ? (
                <img
                  src={url}
                  alt={path.split('/').at(-1)}
                  className="mx-auto max-h-[60vh] max-w-full rounded object-contain"
                  onError={() => setMediaError(true)}
                />
              ) : data.kind === 'audio' ? (
                <div className="space-y-4">
                  <p className="break-all text-sm font-medium">
                    {path.split('/').at(-1)}
                  </p>
                  <audio
                    src={url}
                    controls
                    preload="metadata"
                    className="w-full"
                    onError={() => setMediaError(true)}
                  />
                </div>
              ) : data.kind === 'video' ? (
                <video
                  src={url}
                  controls
                  preload="metadata"
                  className="mx-auto max-h-[60vh] w-full rounded"
                  onError={() => setMediaError(true)}
                />
              ) : (
                <div className="space-y-3">
                  <File className="mx-auto size-9 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {t('files.binary')}
                  </p>
                </div>
              )}
              {(mediaError || data.kind === 'binary') && (
                <Button asChild variant="outline" className="mt-4">
                  <a href={filesApi.raw(threadId, path, true)} download>
                    <Download />
                    {t('files.download')}
                  </a>
                </Button>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

function PreviewLoading() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t('files.loading')}
      className="space-y-3 p-5 motion-safe:animate-pulse"
    >
      <div className="h-4 w-2/3 rounded bg-muted" />
      <div className="h-4 w-4/5 rounded bg-muted" />
      <div className="h-4 w-1/2 rounded bg-muted" />
    </div>
  );
}
