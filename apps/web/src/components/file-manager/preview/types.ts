import type { FilePreview } from '@aime/shared/files';

export type PreviewLinkNavigation = {
  getFileUrl?: (path: string) => string;
  onOpenLink?: (
    path: string,
    kind: 'file' | 'directory',
    line?: number,
  ) => void;
};

export type PreviewRendererProps = {
  data: FilePreview;
  url: string;
  downloadUrl: string;
  line?: number;
  navigation?: number;
  wrap?: boolean;
} & PreviewLinkNavigation;
