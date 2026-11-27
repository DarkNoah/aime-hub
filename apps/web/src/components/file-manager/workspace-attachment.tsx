import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, File, Folder, RotateCcw } from 'lucide-react';
import {
  fileMediaTypes,
  type WorkspaceFileReference,
} from '@aime/shared/files';
import { AudioClip } from '@/components/audio/audio-clip';
import { PreviewImage } from '@/components/image-viewer/preview-image';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fileErrorKey, filesApi } from './api';
import { useWorkspaceFile } from './context';

type WorkspaceAttachmentProps = {
  threadId?: string;
  file: { path: string; name: string; label?: string };
  title?: string;
  className?: string;
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
  title,
  className,
}: WorkspaceAttachmentProps) {
  const { t } = useTranslation();
  const openFile = useWorkspaceFile();
  const container = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<WorkspaceFileReference | null>(null);
  const [error, setError] = useState<ReturnType<typeof fileErrorKey> | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [mediaRevision, setMediaRevision] = useState(0);

  useEffect(() => {
    if (!threadId) return;
    const id = threadId;
    const controller = new AbortController();
    async function load() {
      try {
        // Resolve absolute/relative references and shared mounts on the server.
        const resolved = await filesApi.resolve(
          id,
          file.path,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setTarget(resolved);
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
  const directory = target?.kind === 'directory';
  const [kind, mime] = directory ? [] : (fileMediaTypes[extension ?? ''] ?? []);
  const media = kind === 'image' || kind === 'video' || kind === 'audio';
  const loading = !!threadId && !target && !error;
  const url =
    threadId && target?.kind === 'file'
      ? `${filesApi.raw(threadId, target.path, false, target.scope)}${mediaRevision ? `&retry=${mediaRevision}` : ''}`
      : undefined;
  const downloadUrl =
    threadId && target?.kind === 'file'
      ? filesApi.raw(threadId, target.path, true, target.scope)
      : undefined;
  const label = file.label || file.name;
  const downloadLabel = `${t('files.download')}: ${file.name}`;
  const open = openFile
    ? () => openFile(file.path, directory ? 'directory' : 'file')
    : undefined;
  const Icon = directory ? Folder : File;
  const FileName = open ? Button : 'span';

  return (
    <span
      ref={container}
      className={cn(
        'block min-w-0 group-[.is-user]:ml-auto',
        kind === 'image' && url && !mediaFailed
          ? 'w-fit max-w-full'
          : 'w-full max-w-md',
        className,
      )}
      data-workspace-attachment={file.path}
      data-workspace-image={kind === 'image' ? file.path : undefined}
      aria-busy={loading}
    >
      {kind === 'audio' && url ? (
        <AudioClip
          inline
          src={url}
          filename={file.name}
          label={label}
          mediaType={mime}
          downloadUrl={downloadUrl}
          onOpen={open}
          className="rounded-lg"
        />
      ) : (
        <span className="block overflow-hidden rounded-lg border bg-card text-left">
          {media && url && !mediaFailed ? (
            <span className="block bg-muted/40">
              {kind === 'image' ? (
                <PreviewImage
                  inline
                  src={url}
                  alt={label}
                  title={title}
                  downloadUrl={downloadUrl}
                  containerClassName="grid"
                  className="rounded-none"
                  onError={() => setMediaFailed(true)}
                  onOpen={open}
                />
              ) : (
                <video
                  src={url}
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={label}
                  className="block max-h-80 w-full"
                  onError={() => setMediaFailed(true)}
                />
              )}
            </span>
          ) : media && loading ? (
            <Skeleton
              asChild
              className={`w-full rounded-none ${kind === 'audio' ? 'h-24' : 'aspect-video'}`}
              aria-label={t('files.loading')}
            >
              <span className="block" />
            </Skeleton>
          ) : null}
          {(kind !== 'image' || !url || mediaFailed) && (
            <span className="flex min-w-0 items-center gap-2 p-2">
              <FileName
                type={open ? 'button' : undefined}
                variant={open ? 'ghost' : undefined}
                className="flex h-auto min-w-0 flex-1 items-center justify-start gap-2 px-2 py-1.5 text-left text-sm font-normal"
                onClick={open}
                title={title ?? file.path}
              >
                <Icon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block truncate">{label}</span>
                  {label !== file.name && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {file.name}
                    </span>
                  )}
                </span>
              </FileName>
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
              ) : !directory ? (
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
              ) : null}
            </span>
          )}
          {(error || mediaFailed || !threadId) && (
            <span className="block space-y-2 border-t px-3 py-2 text-xs text-muted-foreground">
              <span role="status" className="block">
                {t(
                  error ??
                    (mediaFailed ? 'files.mediaError' : 'files.unavailable'),
                )}
              </span>
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
            </span>
          )}
        </span>
      )}
    </span>
  );
}
