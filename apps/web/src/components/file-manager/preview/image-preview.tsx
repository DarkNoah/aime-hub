import { MediaPreview } from './preview-frame';
import type { PreviewRendererProps } from './types';

export function ImagePreview({ data, url, downloadUrl }: PreviewRendererProps) {
  return (
    <MediaPreview key={url} data={data} downloadUrl={downloadUrl}>
      {(onError) => (
        <img
          src={url}
          alt={data.path.split('/').at(-1)}
          className="mx-auto max-h-[60vh] max-w-full rounded object-contain"
          onError={onError}
        />
      )}
    </MediaPreview>
  );
}
