import { useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PreviewImage } from '@/components/image-viewer/preview-image';
import { AudioClip } from '@/components/audio/audio-clip';
import type { ReadFileBlock } from './read-file-output';

export function ToolMedia({
  media,
}: {
  media: Extract<ReadFileBlock, { type: 'media' }>;
}) {
  const { t } = useTranslation();
  const [failedSource, setFailedSource] = useState<string>();
  const { source, mediaType, filename } = media;
  const failed = !source || failedSource === source;
  const name = filename?.split('/').at(-1) || t('chat.readFile.attachment');
  const onError = () => setFailedSource(source);
  const kind = mediaType.split('/', 1)[0];
  if (kind === 'audio') {
    return <AudioClip src={source} filename={name} mediaType={mediaType} />;
  }
  return (
    <section
      aria-label={t('chat.readFile.media')}
      className="min-w-0 overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 flex-1 break-all text-xs font-medium">
          {name}
        </span>
        <Badge
          variant="outline"
          className="max-w-full whitespace-normal break-all"
        >
          {mediaType}
        </Badge>
        {source && (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            aria-label={t('files.download')}
            title={t('files.download')}
          >
            <a
              href={source}
              download={name}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download className="size-3.5" aria-hidden="true" />
            </a>
          </Button>
        )}
      </div>
      <div className="min-w-0 p-3">
        {failed ? (
          <p role="status" className="text-sm leading-6 text-muted-foreground">
            {t(source ? 'files.mediaError' : 'chat.readFile.mediaUnavailable')}
          </p>
        ) : kind === 'image' ? (
          <PreviewImage
            src={source}
            alt={name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={onError}
          />
        ) : kind === 'video' ? (
          <video
            src={source}
            controls
            preload="metadata"
            className="max-h-[60vh] w-full rounded"
            onError={onError}
          />
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">
            {t('files.binary')}
          </p>
        )}
      </div>
    </section>
  );
}
