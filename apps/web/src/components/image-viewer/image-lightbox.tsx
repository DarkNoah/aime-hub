import { useMemo, type ComponentProps } from 'react';
import {
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
import Lightbox from 'yet-another-react-lightbox';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import DownloadPlugin from 'yet-another-react-lightbox/plugins/download';
import Fullscreen from 'yet-another-react-lightbox/plugins/fullscreen';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/captions.css';

const plugins = [Captions, DownloadPlugin, Fullscreen, Zoom];
const icons = {
  iconClose: () => <X />,
  iconZoomIn: () => <ZoomIn />,
  iconZoomOut: () => <ZoomOut />,
  iconEnterFullscreen: () => <Maximize />,
  iconExitFullscreen: () => <Minimize />,
  iconDownload: () => <Download />,
  buttonPrev: () => null,
  buttonNext: () => null,
};

export default function ImageLightbox({
  src,
  name,
  downloadUrl,
  dimensions,
  referrerPolicy,
  close,
}: {
  src: string;
  name: string;
  downloadUrl: string;
  dimensions?: { width: number; height: number };
  referrerPolicy?: ComponentProps<'img'>['referrerPolicy'];
  close: () => void;
}) {
  const { t } = useTranslation();
  const slides = useMemo(
    () => [
      {
        src,
        alt: name,
        title: name,
        ...dimensions,
        download: { url: downloadUrl, filename: name },
      },
    ],
    [src, name, dimensions, downloadUrl],
  );

  return (
    <Lightbox
      open
      close={close}
      slides={slides}
      plugins={plugins}
      render={{
        ...icons,
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
        Close: t('common.close'),
        Download: t('files.download'),
        'Zoom in': t('imagePreview.zoomIn'),
        'Zoom out': t('imagePreview.zoomOut'),
        'Enter Fullscreen': t('imagePreview.enterFullscreen'),
        'Exit Fullscreen': t('imagePreview.exitFullscreen'),
        Lightbox: t('imagePreview.gallery'),
        Caption: name,
        'Photo gallery': t('imagePreview.gallery'),
        Carousel: t('imagePreview.gallery'),
      }}
      download={{
        download: ({ saveAs }) => {
          void fetch(downloadUrl, { referrerPolicy })
            .then((response) => {
              if (!response.ok) throw new Error('Image download failed');
              return response.blob();
            })
            .then((blob) => saveAs(blob, name))
            .catch(() => toast.error(t('imagePreview.downloadError')));
        },
      }}
    />
  );
}
