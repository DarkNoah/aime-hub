import type { FilePreview } from '@aime/shared/files';

export type PreviewRendererProps = {
  data: FilePreview;
  url: string;
  downloadUrl: string;
  line?: number;
  wrap?: boolean;
};
