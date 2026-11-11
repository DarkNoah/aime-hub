import {
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ExtraProps } from 'streamdown';
import type { WorkspaceFileReference } from '@aime/shared/files';
import { fileErrorKey, filesApi } from '@/components/file-manager/api';
import { WorkspaceFileThreadContext } from '@/components/file-manager/context';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getWorkspaceFileTarget } from './markdown-file-link';

type MarkdownImageProps = ComponentProps<'img'> & ExtraProps;
const imageClassName = 'my-2 max-h-[60vh] max-w-full rounded-lg object-contain';

export function MarkdownImage({
  src,
  alt = '',
  className,
  title,
}: MarkdownImageProps) {
  const threadId = useContext(WorkspaceFileThreadContext);
  const target = getWorkspaceFileTarget(
    typeof src === 'string' ? src : undefined,
  );
  return target ? (
    <WorkspaceMarkdownImage
      key={`${threadId}:${target.path}`}
      threadId={threadId}
      path={target.path}
      alt={alt}
      className={className}
      title={title}
    />
  ) : (
    <span>{alt}</span>
  );
}

function WorkspaceMarkdownImage({
  threadId,
  path,
  alt,
  className,
  title,
}: {
  threadId?: string;
  path: string;
  alt: string;
  className?: string;
  title?: string;
}) {
  const { t } = useTranslation();
  const container = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<WorkspaceFileReference>();
  const [error, setError] = useState<
    | ReturnType<typeof fileErrorKey>
    | 'chat.preview.fileOnly'
    | 'files.mediaError'
  >();
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const resolved = await filesApi.resolve(
          threadId,
          path,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (resolved.kind !== 'file') setError('chat.preview.fileOnly');
        else setTarget(resolved);
      } catch (cause) {
        if (!controller.signal.aborted) setError(fileErrorKey(cause));
      }
    };
    // Avoid resolving every image in long chat histories before it is visible.
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
  }, [threadId, path, retry]);

  const url =
    threadId && target
      ? `${filesApi.raw(threadId, target.path, false, target.scope)}${retry ? `&retry=${retry}` : ''}`
      : undefined;
  const unavailable = error ?? (!threadId ? 'files.unavailable' : undefined);

  return (
    <span
      ref={container}
      className="my-2 inline-block max-w-full align-middle"
      data-workspace-image={path}
    >
      {url && !unavailable ? (
        <img
          src={url}
          alt={alt}
          title={title}
          loading="lazy"
          className={cn(imageClassName, className)}
          onError={() => setError('files.mediaError')}
        />
      ) : (
        <span
          className="inline-flex min-h-20 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          role="status"
          title={title ?? path}
        >
          <span>
            {alt ? `${alt}: ` : ''}
            {t(unavailable ?? 'files.loading')}
          </span>
          {unavailable && threadId && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setError(undefined);
                setTarget(undefined);
                setRetry((value) => value + 1);
              }}
            >
              {t('files.retry')}
            </Button>
          )}
        </span>
      )}
    </span>
  );
}
