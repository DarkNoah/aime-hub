import { lazy, Suspense, useState, type ComponentProps } from 'react';
import { Expand } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const ImageLightbox = lazy(() => import('./image-lightbox'));

type PreviewImageProps = Pick<
  ComponentProps<'img'>,
  'src' | 'alt' | 'onError' | 'referrerPolicy' | 'loading' | 'className'
> & {
  src: string;
  alt: string;
  downloadUrl?: string;
  containerClassName?: string;
};

export function PreviewImage(props: PreviewImageProps) {
  return <PreviewImageContent key={props.src} {...props} />;
}

function PreviewImageContent({
  src,
  alt,
  downloadUrl = src,
  onError,
  referrerPolicy,
  loading = 'lazy',
  className,
  containerClassName,
}: PreviewImageProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  }>();
  const label = t('imagePreview.open', { name: alt });

  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
        className={cn(
          'group relative mx-auto block max-w-full cursor-zoom-in rounded outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          containerClassName,
        )}
      >
        <img
          src={src}
          alt={alt}
          loading={loading}
          referrerPolicy={referrerPolicy}
          className={cn(
            'mx-auto max-h-[60vh] max-w-full rounded object-contain',
            className,
          )}
          onError={onError}
          onLoad={(event) => {
            const image = event.currentTarget;
            setDimensions({
              width: image.naturalWidth,
              height: image.naturalHeight,
            });
          }}
        />
        <span className="pointer-events-none absolute right-2 bottom-2 rounded-md border bg-background/90 p-1.5 text-foreground transition-colors group-hover:bg-background">
          <Expand className="size-4" aria-hidden="true" />
        </span>
      </button>
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
