import { useMemo, useState, type ComponentProps } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  LoaderCircle,
  Maximize,
  Minimize,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useReducedMotion } from 'motion/react';
import Lightbox from 'yet-another-react-lightbox';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import DownloadPlugin from 'yet-another-react-lightbox/plugins/download';
import Fullscreen from 'yet-another-react-lightbox/plugins/fullscreen';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/captions.css';
import 'yet-another-react-lightbox/plugins/counter.css';

const plugins = [Captions, DownloadPlugin, Fullscreen, Zoom];
const galleryPlugins = [...plugins, Counter];
const icons = {
  iconClose: () => <X />,
  iconZoomIn: () => <ZoomIn />,
  iconZoomOut: () => <ZoomOut />,
  iconEnterFullscreen: () => <Maximize />,
  iconExitFullscreen: () => <Minimize />,
  iconDownload: () => <Download />,
  iconPrev: () => <ChevronLeft />,
  iconNext: () => <ChevronRight />,
};

export type LightboxImage = {
  src: string;
  name: string;
  downloadUrl: string;
  dimensions?: { width: number; height: number };
};

export default function ImageLightbox({
  src,
  name,
  downloadUrl,
  dimensions,
  referrerPolicy,
  close,
  images,
  index = 0,
}: {
  src: string;
  name: string;
  downloadUrl: string;
  dimensions?: { width: number; height: number };
  referrerPolicy?: ComponentProps<'img'>['referrerPolicy'];
  close: () => void;
  images?: LightboxImage[];
  index?: number;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(index);
  const slides = useMemo(
    () =>
      (images ?? [{ src, name, dimensions, downloadUrl }]).map((image) => ({
        src: image.src,
        alt: image.name,
        title: image.name,
        ...image.dimensions,
        download: { url: image.downloadUrl, filename: image.name },
      })),
    [images, src, name, dimensions, downloadUrl],
  );
  const multiple = slides.length > 1;

  return (
    <Lightbox
      open
      close={close}
      slides={slides}
      index={activeIndex}
      on={{ view: ({ index }) => setActiveIndex(index) }}
      animation={
        reducedMotion ? { fade: 0, swipe: 0, navigation: 0 } : undefined
      }
      plugins={multiple ? galleryPlugins : plugins}
      render={{
        ...icons,
        ...(!multiple && {
          buttonPrev: () => null,
          buttonNext: () => null,
        }),
        iconLoading: () => (
          <span role="status" className="flex items-center gap-2 text-sm">
            <LoaderCircle
              className="size-5 motion-safe:animate-spin"
              aria-hidden="true"
            />
            {t('imagePreview.loading')}
          </span>
        ),
        iconError: () => (
          <p role="alert" className="max-w-sm px-4 text-center text-sm">
            {t('files.mediaError')}
          </p>
        ),
      }}
      controller={{ aria: true, closeOnBackdropClick: true }}
      carousel={{ finite: true, imageProps: { referrerPolicy } }}
      zoom={{ scrollToZoom: true, maxZoomPixelRatio: 3 }}
      captions={{ showToggle: false, descriptionTextAlign: 'center' }}
      labels={{
        Previous: t('imagePreview.previous'),
        Next: t('imagePreview.next'),
        Close: t('common.close'),
        Download: t('files.download'),
        'Zoom in': t('imagePreview.zoomIn'),
        'Zoom out': t('imagePreview.zoomOut'),
        'Enter Fullscreen': t('imagePreview.enterFullscreen'),
        'Exit Fullscreen': t('imagePreview.exitFullscreen'),
        Lightbox: t('imagePreview.gallery'),
        Caption: slides[activeIndex]?.alt ?? name,
        'Photo gallery': t('imagePreview.gallery'),
        Carousel: t('imagePreview.gallery'),
      }}
      download={{
        download: ({ slide, saveAs }) => {
          const download = slide.download;
          if (!download || typeof download !== 'object') return;
          void fetch(download.url, { referrerPolicy })
            .then((response) => {
              if (!response.ok) throw new Error('Image download failed');
              return response.blob();
            })
            .then((blob) => saveAs(blob, download.filename))
            .catch(() => toast.error(t('imagePreview.downloadError')));
        },
      }}
    />
  );
}
