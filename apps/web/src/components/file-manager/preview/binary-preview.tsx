import { PreviewFallback, PreviewFrame } from './preview-frame';
import type { PreviewRendererProps } from './types';

export function BinaryPreview({ downloadUrl }: PreviewRendererProps) {
  return (
    <PreviewFrame>
      <PreviewFallback downloadUrl={downloadUrl} />
    </PreviewFrame>
  );
}
