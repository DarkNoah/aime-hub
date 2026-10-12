import webPush from 'web-push';
import type { PushTransport } from './service.js';

export function createPushTransport(config: {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
}): PushTransport | undefined {
  if (!config.publicKey || !config.privateKey || !config.subject)
    return undefined;
  const vapidDetails = {
    publicKey: config.publicKey,
    privateKey: config.privateKey,
    subject: config.subject,
  };
  return {
    publicKey: config.publicKey,
    async send(recipient, id) {
      // Fetch authorized details in the service worker, including after account changes.
      await webPush.sendNotification(
        recipient,
        JSON.stringify({
          id,
          userId: recipient.userId,
          locale: recipient.locale,
        }),
        {
          vapidDetails,
          TTL: 24 * 60 * 60,
          urgency: 'normal',
          timeout: 10000,
        },
      );
    },
  };
}
