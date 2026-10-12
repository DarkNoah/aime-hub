/* This worker only handles notifications; it never caches authenticated pages. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data?.json();
      } catch {
        return;
      }
      if (
        !payload ||
        !/^[a-f0-9]{64}$/.test(payload.id) ||
        typeof payload.userId !== 'string'
      )
        return;
      // Recheck the signed-in account and current project/admin access after delivery.
      const response = await fetch(`/api/notifications/${payload.id}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!response.ok) return;
      const { userId, notification } = await response.json();
      if (userId !== payload.userId || notification.id !== payload.id) return;
      const url = new URL(notification.url, self.location.origin);
      if (url.origin !== self.location.origin) return;
      const chinese = payload.locale === 'zh-CN';
      const title =
        notification.status === 'succeeded'
          ? chinese
            ? '自动化已完成'
            : 'Automation completed'
          : chinese
            ? '自动化执行失败'
            : 'Automation failed';
      await self.registration.showNotification(title, {
        body: notification.taskName,
        tag: notification.id,
        data: { url: url.href },
        timestamp: Date.parse(notification.createdAt),
      });
    })(),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL(
        event.notification.data?.url ?? '/automations',
        self.location.origin,
      );
      if (url.origin !== self.location.origin) return;
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(url.href);
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
