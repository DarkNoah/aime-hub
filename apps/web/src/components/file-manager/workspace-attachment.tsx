import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, File, RotateCcw } from 'lucide-react';
import {
  fileMediaTypes,
  type WorkspaceFileReference,
} from '@aime/shared/files';
import { AudioClip } from '@/components/audio/audio-clip';
import { PreviewImage } from '@/components/image-viewer/preview-image';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fileErrorKey, filesApi } from './api';
import { useWorkspaceFile } from './context';

type WorkspaceAttachmentProps = {
  threadId?: string;
  file: { path: string; name: string };
};

export function WorkspaceAttachment(props: WorkspaceAttachmentProps) {
  return (
    <WorkspaceAttachmentContent
      key={`${props.threadId}:${props.file.path}`}
      {...props}
    />
  );
}

function WorkspaceAttachmentContent({
  threadId,
  file,
}: WorkspaceAttachmentProps) {
  const { t } = useTranslation();
  const openFile = useWorkspaceFile();
  const container = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<WorkspaceFileReference | null>(null);
  const [error, setError] = useState<
    ReturnType<typeof fileErrorKey> | 'chat.preview.fileOnly' | null
  >(null);
  const [retry, setRetry] = useState(0);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [mediaRevision, setMediaRevision] = useState(0);

  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    async function load() {
      try {
        // Resolve absolute/relative references and shared mounts on the server.
        const resolved = await filesApi.resolve(
          threadId!,
          file.path,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (resolved.kind !== 'file') setError('chat.preview.fileOnly');
        else setTarget(resolved);
      } catch (cause) {
        if (!controller.signal.aborted) setError(fileErrorKey(cause));
      }
    }
    // Long histories should not resolve or preload every attached media file.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void load();
      },
      { rootMargin: '240px' },
    );
    if (container.current) observer.observe(container.current);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [threadId, file.path, retry]);

  // The server's raw-file response uses this same extension/MIME registry.
  const extension = (target?.path ?? file.path)
    .match(/\.[^./]+$/)?.[0]
    .toLowerCase();
  const [kind, mime] = fileMediaTypes[extension ?? ''] ?? [];
  const media = kind === 'image' || kind === 'video' || kind === 'audio';
  const url =
    threadId && target
      ? filesApi.raw(threadId, target.path, false, target.scope)
      : undefined;
  const downloadUrl =
    threadId && target
      ? filesApi.raw(threadId, target.path, true, target.scope)
      : undefined;
  const downloadLabel = `${t('files.download')}: ${file.name}`;

  return (
    <div
      ref={container}
      className="w-full min-w-0 max-w-md group-[.is-user]:ml-auto"
      data-workspace-attachment={file.path}
    >
      {kind === 'audio' && url ? (
        <AudioClip
          src={url}
          filename={file.name}
          mediaType={mime}
          downloadUrl={downloadUrl}
          onOpen={openFile ? () => openFile(file.path) : undefined}
          className="rounded-lg"
        />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          {media && url && !mediaFailed ? (
            <div key={mediaRevision} className="bg-muted/40">
              {kind === 'image' ? (
                <PreviewImage
                  src={url}
                  alt={file.name}
                  downloadUrl={downloadUrl}
                  containerClassName="w-full"
                  className="max-h-80 rounded-none"
                  onError={() => setMediaFailed(true)}
                />
              ) : (
                <video
                  src={url}
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={file.name}
                  className="block max-h-80 w-full"
                  onError={() => setMediaFailed(true)}
                />
              )}
            </div>
          ) : media && !error && threadId && !target ? (
            <Skeleton
              className={`w-full rounded-none ${kind === 'audio' ? 'h-24' : 'aspect-video'}`}
              aria-label={t('files.loading')}
            />
          ) : null}
          <div className="flex min-w-0 items-center gap-2 p-2">
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-sm font-normal"
              disabled={!openFile}
              onClick={() => openFile?.(file.path)}
              title={file.path}
            >
              <File
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">{file.name}</span>
            </Button>
            {downloadUrl ? (
              <Button asChild variant="ghost" size="icon-sm">
                <a
                  href={downloadUrl}
                  download={file.name}
                  aria-label={downloadLabel}
                  title={downloadLabel}
                >
                  <Download className="size-4" aria-hidden="true" />
                </a>
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled
                aria-label={downloadLabel}
                title={downloadLabel}
              >
                <Download className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
          {(error || mediaFailed || !threadId) && (
            <div className="space-y-2 border-t px-3 py-2 text-xs text-muted-foreground">
              <p role="status">
                {t(
                  error ??
                    (mediaFailed ? 'files.mediaError' : 'files.unavailable'),
                )}
              </p>
              {threadId && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (mediaFailed) {
                      setMediaFailed(false);
                      setMediaRevision((value) => value + 1);
                    } else {
                      setError(null);
                      setRetry((value) => value + 1);
                    }
                  }}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  {t('files.retry')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
