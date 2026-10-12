import { RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { FileUploadsState } from './use-file-uploads';

export function UploadList({
  uploads,
  compact = false,
}: {
  uploads: FileUploadsState;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  if (!uploads.items.length) return null;
  return (
    <div className="shrink-0 border-t bg-muted/20">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-xs font-medium">{t('files.uploadQueue')}</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-xs"
          onClick={uploads.clear}
        >
          {t('files.uploadClear')}
        </Button>
      </div>
      <ScrollArea
        className={compact ? 'max-h-24' : 'max-h-44'}
        viewportProps={{
          className: compact
            ? 'max-h-24 [&>div]:!block'
            : 'max-h-44 [&>div]:!block',
        }}
      >
        <div className="space-y-3 px-3 pb-3">
          {uploads.items
            .slice()
            .reverse()
            .map((item) => (
              <div key={item.id} className="min-w-0 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className="min-w-0 flex-1 truncate text-xs"
                    title={item.file.name}
                  >
                    {item.file.name}
                  </span>
                  <Badge
                    variant={
                      item.status === 'error' ? 'destructive' : 'secondary'
                    }
                    className="shrink-0 px-1.5 py-0 text-[10px]"
                  >
                    {t(`files.uploadStatus.${item.status}`)}
                  </Badge>
                  {['error', 'cancelled'].includes(item.status) && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 shrink-0"
                      aria-label={t('files.uploadRetry', {
                        name: item.file.name,
                      })}
                      onClick={() => uploads.retry(item)}
                    >
                      <RotateCcw className="size-3" />
                    </Button>
                  )}
                  {['queued', 'uploading'].includes(item.status) && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 shrink-0"
                      aria-label={t('files.uploadCancel', {
                        name: item.file.name,
                      })}
                      onClick={() => uploads.cancel(item.id)}
                    >
                      <X className="size-3" />
                    </Button>
                  )}
                </div>
                <p
                  className="truncate text-[10px] text-muted-foreground"
                  title={`/${item.directory}`}
                >
                  {item.directory ? `/${item.directory}` : t('files.root')}
                </p>
                {['uploading', 'finishing'].includes(item.status) && (
                  <div className="flex items-center gap-2">
                    <Progress
                      value={item.progress}
                      aria-valuenow={item.progress}
                      aria-label={t('files.uploadProgress', {
                        name: item.file.name,
                      })}
                      className="h-1 flex-1"
                    />
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {item.progress}%
                    </span>
                  </div>
                )}
                {item.error && (
                  <p role="alert" className="text-[11px] text-destructive">
                    {t(item.error)}
                  </p>
                )}
              </div>
            ))}
        </div>
      </ScrollArea>
    </div>
  );
}
