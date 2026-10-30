import { lazy, Suspense, type ComponentType } from 'react';
import { AudioPreview } from './audio-preview';
import { BinaryPreview } from './binary-preview';
import { ImagePreview } from './image-preview';
import { getPreviewKind, type PreviewKind } from './preview-kind';
import { PreviewLoading } from './preview-loading';
import type { PreviewRendererProps } from './types';
import { VideoPreview } from './video-preview';

const renderers: Record<PreviewKind, ComponentType<PreviewRendererProps>> = {
  text: lazy(() => import('./text-preview')),
  html: lazy(() => import('./html-preview')),
  markdown: lazy(() => import('./markdown-preview')),
  pdf: lazy(() => import('./pdf-preview')),
  model: lazy(() => import('./model-preview')),
  image: ImagePreview,
  audio: AudioPreview,
  video: VideoPreview,
  binary: BinaryPreview,
};

export function FilePreviewContent({
  source = false,
  ...props
}: PreviewRendererProps & { source?: boolean }) {
  const Renderer =
    renderers[
      source && props.data.kind === 'text' ? 'text' : getPreviewKind(props.data)
    ];
  return (
    <Suspense fallback={<PreviewLoading />}>
      <Renderer key={props.url} {...props} />
    </Suspense>
  );
}
