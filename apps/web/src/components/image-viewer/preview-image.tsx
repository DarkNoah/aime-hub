import { lazy, Suspense, useState, type ComponentProps } from 'react';
import { Download, Expand, File } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ImageEditButton } from './image-edit-button';

const ImageLightbox = lazy(() => import('./image-lightbox'));

type PreviewImageProps = Pick<
  ComponentProps<'img'>,
  | 'src'
  | 'alt'
  | 'title'
  | 'onError'
  | 'referrerPolicy'
  | 'loading'
  | 'className'
> & {
  src: string;
  alt: string;
  downloadUrl?: string;
  containerClassName?: string;
  inline?: boolean;
  onPreview?: () => void;
  onOpen?: () => void;
};

export function PreviewImage(props: PreviewImageProps) {
  return <PreviewImageContent key={props.src} {...props} />;
}

function PreviewImageContent({
  src,
  alt,
  title,
  downloadUrl = src,
  onError,
  referrerPolicy,
  loading = 'lazy',
  className,
  containerClassName,
  inline = false,
  onPreview,
  onOpen,
}: PreviewImageProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  }>();
  const label = t('imagePreview.open', { name: alt });
  const Container = inline ? 'span' : 'div';
  const preview = () => (onPreview ? onPreview() : setOpen(true));
  const actionClassName =
    'text-white hover:bg-white/20 hover:text-white dark:hover:bg-white/20 focus-visible:ring-white/70 shadow-none';

  return (
    <>
      <Container
        data-image-preview
        className={cn(
          'relative mx-auto w-fit max-w-full',
          inline && 'inline-block align-middle',
          containerClassName,
        )}
      >
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          title={label}
          disabled={failed}
          onClick={preview}
          className={cn(
            'group relative mx-auto block max-w-full cursor-zoom-in rounded outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'w-full disabled:cursor-default',
          )}
        >
          <img
            src={src}
            alt={alt}
            title={title ?? alt}
            loading={loading}
            referrerPolicy={referrerPolicy}
            className={cn(
              'mx-auto max-h-[60vh] max-w-full rounded object-contain',
              className,
            )}
            onError={(event) => {
              setFailed(true);
              onError?.(event);
            }}
            onLoad={(event) => {
              const image = event.currentTarget;
              setDimensions({
                width: image.naturalWidth,
                height: image.naturalHeight,
              });
            }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-[inherit] bg-linear-to-t from-black/75 via-black/55 to-transparent"
          />
        </button>
        <span
          data-image-actions
          className="absolute right-2 bottom-2 flex max-w-[calc(100%-1rem)] flex-wrap items-center justify-end gap-0.5"
        >
          {onOpen && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={actionClassName}
              aria-label={t('files.openPreview', { path: alt })}
              title={t('files.openPreview', { path: alt })}
              onClick={onOpen}
            >
              <File className="size-3.5" aria-hidden="true" />
            </Button>
          )}
          {!failed && (
            <ImageEditButton
              src={src}
              name={alt}
              referrerPolicy={referrerPolicy}
              variant="ghost"
              size="icon-sm"
              className={actionClassName}
            />
          )}
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className={actionClassName}
          >
            <a
              href={downloadUrl}
              download={alt}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy={referrerPolicy}
              aria-label={`${t('files.download')}: ${alt}`}
              title={t('files.download')}
            >
              <Download className="size-3.5" aria-hidden="true" />
            </a>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={actionClassName}
            disabled={failed}
            aria-label={t('imagePreview.zoomIn')}
            title={label}
            aria-haspopup="dialog"
            onClick={preview}
          >
            <Expand className="size-3.5" aria-hidden="true" />
          </Button>
        </span>
      </Container>
      {open && (
        <Suspense fallback={null}>
          <ImageLightbox
            src={src}
            name={alt}
            downloadUrl={downloadUrl}
            dimensions={dimensions}
            referrerPolicy={referrerPolicy}
            close={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
