import {
  useEffect,
  useRef,
  useState,
  type DetailedHTMLProps,
  type HTMLAttributes,
} from 'react';
import { ModelViewerElement } from '@google/model-viewer';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PreviewFallback, PreviewFrame } from './preview-frame';
import { PreviewLoading } from './preview-loading';
import type { PreviewRendererProps } from './types';

// Serve compressed-model decoders with the app, including in offline deployments.
const assetRoot = `${import.meta.env.BASE_URL}file-preview/model/`;
ModelViewerElement.dracoDecoderLocation = `${assetRoot}draco/`;
ModelViewerElement.ktx2TranscoderLocation = `${assetRoot}basis/`;

type ModelViewerProps = DetailedHTMLProps<
  HTMLAttributes<ModelViewerElement>,
  ModelViewerElement
>;

declare module 'react' {
  // React requires JSX namespace augmentation for custom elements.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': ModelViewerProps & {
        src: string;
        alt: string;
        'camera-controls': boolean;
        'interaction-prompt': string;
        'touch-action': string;
      };
    }
  }
}

export default function ModelPreview({
  data,
  url,
  downloadUrl,
}: PreviewRendererProps) {
  const { t } = useTranslation();
  const viewer = useRef<ModelViewerElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [animated, setAnimated] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const element = viewer.current;
    if (!element) return;
    const onLoad = () => {
      setLoaded(true);
      setAnimated(element.availableAnimations.length > 0);
    };
    const onError = () => setFailed(true);
    element.addEventListener('load', onLoad);
    element.addEventListener('error', onError);
    if (element.loaded) onLoad();
    return () => {
      element.pause();
      element.removeEventListener('load', onLoad);
      element.removeEventListener('error', onError);
    };
  }, []);

  if (failed) {
    return (
      <PreviewFrame>
        <PreviewFallback
          downloadUrl={downloadUrl}
          mediaError
          message={t('files.modelError')}
        />
      </PreviewFrame>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-end gap-1 border-b px-3 py-1.5">
        {animated && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (playing) viewer.current?.pause();
              else viewer.current?.play();
              setPlaying(!playing);
            }}
          >
            {playing ? <Pause /> : <Play />}
            {t(playing ? 'files.pauseAnimation' : 'files.playAnimation')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!loaded}
          onClick={() => {
            const element = viewer.current;
            if (!element) return;
            element.cameraOrbit = 'auto auto auto';
            element.cameraTarget = 'auto auto auto';
            element.fieldOfView = 'auto';
            element.jumpCameraToGoal();
          }}
        >
          <RotateCcw />
          {t('files.resetView')}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-muted/30">
        <model-viewer
          ref={viewer}
          src={url}
          alt={t('files.modelPreview', { name: data.path })}
          camera-controls
          interaction-prompt="none"
          touch-action="none"
          className="block size-full"
        />
        {!loaded && (
          <div className="pointer-events-none absolute inset-0">
            <PreviewLoading />
          </div>
        )}
      </div>
      <p className="shrink-0 border-t px-3 py-2 text-center text-xs text-muted-foreground">
        {t('files.modelHint')}
      </p>
    </div>
  );
}
