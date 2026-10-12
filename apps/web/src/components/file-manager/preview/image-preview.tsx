import { PreviewImage } from '@/components/image-viewer/preview-image';
import { MediaPreview } from './preview-frame';
import type { PreviewRendererProps } from './types';

export function ImagePreview({ data, url, downloadUrl }: PreviewRendererProps) {
  return (
    <MediaPreview key={url} data={data} downloadUrl={downloadUrl}>
      {(onError) => (
        <PreviewImage
          src={url}
          alt={data.path.split('/').at(-1) || data.path}
          downloadUrl={downloadUrl}
          onError={onError}
        />
      )}
    </MediaPreview>
  );
}
