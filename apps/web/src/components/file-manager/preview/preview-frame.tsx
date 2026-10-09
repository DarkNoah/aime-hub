import { useState, type ReactNode } from 'react';
import { Download, File } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PreviewRendererProps } from './types';

export function PreviewFrame({ children }: { children: ReactNode }) {
  return (
    <ScrollArea
      className="h-full"
      viewportProps={{
        className:
          '[&>div]:!flex [&>div]:min-h-full [&>div]:items-center [&>div]:justify-center',
      }}
    >
      <div className="w-full min-w-0 p-5 text-center">{children}</div>
    </ScrollArea>
  );
}

export function PreviewFallback({
  downloadUrl,
  mediaError = false,
}: {
  downloadUrl: string;
  mediaError?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div>
      {!mediaError && (
        <File className="mx-auto mb-3 size-9 text-muted-foreground" />
      )}
      <p
        role={mediaError ? 'alert' : undefined}
        className="text-sm text-muted-foreground"
      >
        {t(mediaError ? 'files.mediaError' : 'files.binary')}
      </p>
      <Button asChild variant="outline" className="mt-4">
        <a href={downloadUrl} download>
          <Download />
          {t('files.download')}
        </a>
      </Button>
    </div>
  );
}

export function MediaPreview({
  children,
  data,
  downloadUrl,
}: Pick<PreviewRendererProps, 'data' | 'downloadUrl'> & {
  children: (onError: () => void) => ReactNode;
}) {
  const [failedData, setFailedData] = useState<PreviewRendererProps['data']>();
  return (
    <PreviewFrame>
      {failedData === data ? (
        <PreviewFallback downloadUrl={downloadUrl} mediaError />
      ) : (
        children(() => setFailedData(data))
      )}
    </PreviewFrame>
  );
}
