import { z } from 'zod';
import { automationScopeSchema } from './automations.js';

export const notificationSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskName: z.string(),
  scope: automationScopeSchema,
  status: z.enum(['succeeded', 'failed']),
  createdAt: z.string(),
  url: z.string().regex(/^\/(?!\/)[^\\]*$/),
});
export type TaskNotification = z.infer<typeof notificationSchema>;
const cursor = z.string().regex(/^\d{1,18}$/);
export const notificationEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('notification'),
    cursor,
    notification: notificationSchema,
  }),
  z.object({ type: z.literal('ready'), cursor }),
]);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

// Only browser push services may receive server requests from a subscription.
export const pushEndpointSchema = z
  .url()
  .max(4096)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (url.hostname === 'fcm.googleapis.com' ||
        url.hostname === 'web.push.apple.com' ||
        /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/.test(url.hostname) ||
        /^(?:[a-z0-9-]+\.)*(?:notify|wns)\.windows\.com$/.test(url.hostname))
    );
  });
export const pushSubscriptionSchema = z
  .object({
    endpoint: pushEndpointSchema,
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}=?$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}(?:==)?$/),
      })
      .strict(),
    locale: z.enum(['zh-CN', 'en']).default('en'),
  })
  .strict();
export type BrowserPushSubscription = z.infer<typeof pushSubscriptionSchema>;
