import { MediaPreview } from './preview-frame';
import type { PreviewRendererProps } from './types';

export function VideoPreview({ data, url, downloadUrl }: PreviewRendererProps) {
  return (
    <MediaPreview key={url} data={data} downloadUrl={downloadUrl}>
      {(onError) => (
        <video
          src={url}
          controls
          preload="metadata"
          className="mx-auto max-h-[60vh] w-full rounded"
          onError={onError}
        />
      )}
    </MediaPreview>
  );
}
