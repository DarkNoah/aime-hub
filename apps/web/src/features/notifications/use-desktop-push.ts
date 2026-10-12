import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/rpc';
import { pushSupported, registerDesktopPush } from './desktop-push';

type PushError =
  | ''
  | 'notifications.unavailable'
  | 'notifications.denied'
  | 'notifications.enableFailed';
export function useDesktopPush() {
  const { i18n } = useTranslation();
  const [publicKey, setPublicKey] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PushError>('');
  const [registered, setRegistered] = useState(false);
  const supported = pushSupported();
  useEffect(() => {
    let active = true;
    void api.notifications
      .config()
      .then(async (value) => {
        if (active) setPublicKey(value.publicKey);
        if (supported && Notification.permission === 'granted') {
          const registration = await navigator.serviceWorker.getRegistration(
            '/notification-sw.js',
          );
          const subscription =
            await registration?.pushManager.getSubscription();
          if (active) setRegistered(Boolean(subscription));
        }
      })
      .catch(() => {
        if (active) setError('notifications.unavailable');
      });
    return () => {
      active = false;
    };
  }, [supported]);
  async function enable() {
    if (!publicKey || busy) return false;
    setBusy(true);
    setError('');
    try {
      await registerDesktopPush(publicKey, i18n.language, true);
      setRegistered(true);
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === 'denied'
          ? 'notifications.denied'
          : 'notifications.enableFailed',
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { publicKey, busy, error, registered, supported, enable };
}
