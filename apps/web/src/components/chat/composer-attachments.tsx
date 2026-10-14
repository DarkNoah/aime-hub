import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Attachment,
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from '@/components/ai-elements/attachments';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { fileErrorKey } from '../file-manager/api';
import type { ChatUpload, ChatUploadQueue } from './chat-uploads';

export function ComposerAttachments({
  items,
  queue,
  disabled,
}: {
  items: ChatUpload[];
  queue: ChatUploadQueue;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  if (!items.length) return null;
  return (
    <Attachments variant="inline" className="w-full min-w-0 px-3 pt-3">
      {items.map((item) => (
        <AttachmentHoverCard key={item.id}>
          <AttachmentHoverCardTrigger asChild>
            <Attachment
              data={{
                id: item.id,
                type: 'file',
                filename: item.file.name,
                mediaType: item.preview
                  ? item.file.type
                  : item.file.type.startsWith('image/')
                    ? 'application/octet-stream'
                    : item.file.type,
                url: item.preview,
              }}
              onRemove={() => queue.cancel(item.id)}
              className="max-w-full min-w-0"
              tabIndex={0}
            >
              <AttachmentPreview />
              <AttachmentInfo className="max-w-32 @xl/chat:max-w-48" />
              <Badge
                variant={item.status === 'error' ? 'destructive' : 'secondary'}
                className="shrink-0 px-1.5 py-0 text-[10px]"
              >
                {item.status === 'uploading'
                  ? `${item.progress}%`
                  : t(`files.uploadStatus.${item.status}`)}
              </Badge>
              {item.status === 'error' && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="size-5 shrink-0"
                  disabled={disabled}
                  aria-label={t('files.uploadRetry', { name: item.file.name })}
                  onClick={() => queue.retry(item.id)}
                >
                  <RotateCcw className="size-3" />
                </Button>
              )}
              <AttachmentRemove
                disabled={disabled}
                label={t(
                  item.status === 'done'
                    ? 'assets.remove'
                    : 'files.uploadCancel',
                  { name: item.file.name },
                )}
                className="shrink-0 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
              />
            </Attachment>
          </AttachmentHoverCardTrigger>
          <AttachmentHoverCardContent
            side="top"
            className="max-w-[min(20rem,calc(100vw-2rem))] space-y-2"
          >
            {item.preview && (
              <img
                src={item.preview}
                alt={item.file.name}
                className="max-h-64 w-full rounded object-contain"
              />
            )}
            <p className="break-all text-sm">{item.file.name}</p>
            <p className="break-all text-xs text-muted-foreground">
              {item.path
                ? `/${item.path}`
                : t(`files.uploadStatus.${item.status}`)}
            </p>
            {['uploading', 'finishing'].includes(item.status) && (
              <Progress
                value={item.progress}
                aria-valuenow={item.progress}
                aria-label={t('files.uploadProgress', { name: item.file.name })}
                className="h-1"
              />
            )}
            {item.error != null && (
              <p role="alert" className="text-xs text-destructive">
                {t(fileErrorKey(item.error))}
              </p>
            )}
          </AttachmentHoverCardContent>
        </AttachmentHoverCard>
      ))}
    </Attachments>
  );
}
