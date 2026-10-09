import { MediaPreview } from './preview-frame';
import type { PreviewRendererProps } from './types';

export function AudioPreview({ data, url, downloadUrl }: PreviewRendererProps) {
  return (
    <MediaPreview key={url} data={data} downloadUrl={downloadUrl}>
      {(onError) => (
        <div className="space-y-4">
          <p className="break-all text-sm font-medium">
            {data.path.split('/').at(-1)}
          </p>
          <audio
            src={url}
            controls
            preload="metadata"
            className="w-full"
            onError={onError}
          />
        </div>
      )}
    </MediaPreview>
  );
}
