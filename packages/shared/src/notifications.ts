import { z } from 'zod';
import { automationScopeSchema } from './automations.js';

const taskNotificationSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskName: z.string(),
  scope: automationScopeSchema,
  status: z.enum(['succeeded', 'failed']),
  createdAt: z.string(),
  url: z.string().regex(/^\/(?!\/)[^\\]*$/),
});
export type TaskNotification = z.infer<typeof taskNotificationSchema>;
export const notificationSoundSchema = z.enum(['entry', 'exit']);
export type NotificationSound = z.infer<typeof notificationSoundSchema>;
export const marketSignalNotificationSchema = z.object({
  type: z.enum(['entry', 'exit']),
  side: z.enum(['long', 'short', 'unknown']),
  strategyName: z.string(),
  version: z.number(),
  symbol: z.string(),
  time: z.number(),
  price: z.number().nullable(),
  reason: z.string(),
  replay: z.boolean().optional(),
});
export type MarketSignalNotification = z.infer<
  typeof marketSignalNotificationSchema
>;
export const pluginNotificationSchema = z.object({
  kind: z.literal('plugin'),
  id: z.string(),
  pluginId: z.string(),
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string().regex(/^\/(?!\/)[^\\]*$/),
  toast: z.boolean(),
  sound: notificationSoundSchema.optional(),
  marketSignal: marketSignalNotificationSchema.optional(),
});
export const notificationSchema = z.union([
  taskNotificationSchema,
  pluginNotificationSchema,
]);
export type AppNotification = z.infer<typeof notificationSchema>;
export interface PluginNotificationInput {
  userId: string;
  eventId: string;
  title: string;
  body: string;
  url: string;
  toast: boolean;
  desktop: boolean;
  sound?: NotificationSound;
  marketSignal?: MarketSignalNotification;
}
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
