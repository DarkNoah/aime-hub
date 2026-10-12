import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { notificationEventSchema } from '@aime/shared/notifications';
import { useAuthSession } from '@/features/auth/session-context';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-manager';
import { refreshDesktopPush } from './desktop-push';

export function NotificationProvider() {
  const { data } = useAuthSession();
  const { t, i18n } = useTranslation();
  const userId = data?.user.id;
  const sessionId = data?.session.id;
  useEffect(() => {
    if (!userId) return;
    const key = `notification-cursor:${userId}`;
    let cursor: string | undefined;
    try {
      cursor = localStorage.getItem(key) ?? undefined;
    } catch {
      /* Storage can be disabled. */
    }
    if (cursor && !/^\d{1,18}$/.test(cursor)) cursor = undefined;
    let stopped = false;
    let source: EventSource;
    let retry: ReturnType<typeof setTimeout>;
    const openToasts = new Set<string>();
    const connect = () => {
      if (stopped) return;
      source = new EventSource(
        `/api/notifications/events${cursor ? `?after=${cursor}` : ''}`,
      );
      source.addEventListener('notification', (message) => {
        let raw: unknown;
        try {
          raw = JSON.parse((message as MessageEvent).data);
        } catch {
          return;
        }
        const parsed = notificationEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const event = parsed.data;
        if (
          event.type === 'notification' &&
          cursor !== undefined &&
          BigInt(event.cursor) <= BigInt(cursor)
        )
          return;
        cursor = event.cursor;
        try {
          localStorage.setItem(key, cursor);
        } catch {
          /* Toasts still work without persistence. */
        }
        if (event.type !== 'notification') return;
        const notification = event.notification;
        const id = toast.add({
          id: notification.id,
          title: t(
            notification.status === 'succeeded'
              ? 'notifications.completed'
              : 'notifications.failed',
          ),
          description: notification.taskName,
          type: notification.status === 'succeeded' ? 'success' : 'error',
          actionProps: {
            children: t('notifications.view'),
            onClick: () => {
              window.location.assign(notification.url);
              toast.close(notification.id);
            },
          },
          onClose: () => openToasts.delete(notification.id),
        });
        openToasts.add(id);
      });
      source.addEventListener('expired', () => {
        stopped = true;
        source.close();
      });
      source.onerror = () => {
        source.close();
        if (!stopped) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    void refreshDesktopPush(i18n.language).catch(() => {
      /* The editor offers explicit permission/setup feedback. */
    });
    return () => {
      stopped = true;
      source?.close();
      clearTimeout(retry);
      for (const id of openToasts) toast.close(id);
    };
  }, [userId, sessionId, t, i18n.language]);
  return <Toaster />;
}
