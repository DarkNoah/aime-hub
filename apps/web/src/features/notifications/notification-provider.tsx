import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { notificationEventSchema } from '@aime/shared/notifications';
import { useAuthSession } from '@/features/auth/session-context';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-manager';
import {
  createNotificationSoundSession,
  enableNotificationSound,
} from './notification-sound';
import { refreshDesktopPush } from './desktop-push';
import { SharedEventSource } from '@/components/realtime/event-source';
import { toast as signalToast } from 'sonner';

export function NotificationProvider() {
  const { data } = useAuthSession();
  const { t, i18n } = useTranslation();
  const userId = data?.user.id;
  const sessionId = data?.session.id;
  useEffect(() => {
    if (!userId || !sessionId) return;
    const key = `notification-cursor:${userId}`;
    let cursor: string | undefined;
    try {
      cursor = localStorage.getItem(key) ?? undefined;
    } catch {
      /* Storage can be disabled. */
    }
    if (cursor && !/^\d{1,18}$/.test(cursor)) cursor = undefined;
    let stopped = false;
    let source: SharedEventSource;
    let retry: ReturnType<typeof setTimeout>;
    const openToasts = new Set<string>();
    const signalToasts = new Set<string>();
    const sounds = createNotificationSoundSession(userId);
    const connect = () => {
      if (stopped) return;
      source = new SharedEventSource(
        `/api/notifications/events${cursor ? `?after=${cursor}` : ''}`,
        sessionId,
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
        if ('kind' in notification) {
          void sounds.notify(notification).then((result) => {
            if (
              stopped ||
              result !== 'blocked' ||
              document.visibilityState !== 'visible'
            )
              return;
            signalToast(t('notifications.soundBlocked'), {
              id: 'notification-sound-unlock',
              duration: 10000,
              action: {
                label: t('notifications.enableSound'),
                onClick: async () => {
                  if (await enableNotificationSound())
                    signalToast.dismiss('notification-sound-unlock');
                  else signalToast.error(t('notifications.soundUnavailable'));
                },
              },
            });
          });
          if (!notification.toast) return;
          signalToasts.add(notification.id);
          signalToast(notification.title, {
            id: notification.id,
            description: notification.body,
            duration: 10000,
            action: {
              label: t('notifications.view'),
              onClick: () => window.location.assign(notification.url),
            },
            onDismiss: () => signalToasts.delete(notification.id),
            onAutoClose: () => signalToasts.delete(notification.id),
          });
          return;
        }
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
        sounds.dispose();
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
      sounds.dispose();
      signalToast.dismiss('notification-sound-unlock');
      source?.close();
      clearTimeout(retry);
      for (const id of openToasts) toast.close(id);
      for (const id of signalToasts) signalToast.dismiss(id);
    };
  }, [userId, sessionId, t, i18n.language]);
  return <Toaster />;
}
