import { api } from '@/lib/rpc';

export function pushSupported() {
  return (
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}
function applicationKey(value: string) {
  return Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')),
    (char) => char.charCodeAt(0),
  );
}
export async function registerDesktopPush(
  publicKey: string,
  locale: string,
  requestPermission: boolean,
) {
  if (!pushSupported()) throw new Error('unsupported');
  const permission = requestPermission
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission !== 'granted')
    throw new Error(permission === 'denied' ? 'denied' : 'dismissed');
  const registration = await navigator.serviceWorker.register(
    '/notification-sw.js',
    { scope: '/' },
  );
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const key = applicationKey(publicKey);
  if (
    subscription &&
    subscription.options.applicationServerKey &&
    Array.from(
      new Uint8Array(subscription.options.applicationServerKey),
    ).join() !== Array.from(key).join()
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const json = subscription.toJSON();
  await api.notifications.subscribe({
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
    locale: locale.startsWith('zh') ? 'zh-CN' : 'en',
  });
}

export async function refreshDesktopPush(locale: string) {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const registration = await navigator.serviceWorker.getRegistration(
    '/notification-sw.js',
  );
  if (!registration) return;
  const { publicKey } = await api.notifications.config();
  if (publicKey) await registerDesktopPush(publicKey, locale, false);
}
