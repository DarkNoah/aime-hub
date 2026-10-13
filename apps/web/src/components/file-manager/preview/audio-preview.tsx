import { AudioClip } from '@/components/audio/audio-clip';
import { PreviewFrame } from './preview-frame';
import type { PreviewRendererProps } from './types';

export function AudioPreview({ data, url, downloadUrl }: PreviewRendererProps) {
  return (
    <PreviewFrame>
      <AudioClip
        src={url}
        filename={data.path.split('/').at(-1) || data.path}
        mediaType={data.mime}
        downloadUrl={downloadUrl}
        className="mx-auto max-w-lg"
      />
    </PreviewFrame>
  );
}
