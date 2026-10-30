import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useRoomUnread } from '../unread-context';
import type { RoomUnreadScope } from '../unread-resource';

export function RoomUnreadDot({
  className,
  ...scope
}: RoomUnreadScope & { className?: string }) {
  const unread = useRoomUnread(scope);
  const { t } = useTranslation();
  if (!unread) return null;
  return (
    <Badge
      variant="secondary"
      className={cn(
        'size-2 shrink-0 border-0 bg-blue-500 p-0 dark:bg-blue-400',
        className,
      )}
      role="status"
      aria-label={t('groupChat.unread')}
      title={t('groupChat.unread')}
    />
  );
}
