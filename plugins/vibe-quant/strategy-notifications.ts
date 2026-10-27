import { z } from 'zod';

/** Channel IDs are stable; additional channels and channel options survive edits. */
export const strategyNotificationsSchema = z.object({
  channels: z.record(z.string(), z.looseObject({ enabled: z.boolean() })),
});
export type StrategyNotifications = z.infer<typeof strategyNotificationsSchema>;

export const STRATEGY_NOTIFICATION_CHANNELS = [
  {
    id: 'toast',
    label: '前台 Toast',
    description: '在应用页面内显示通知。',
  },
  {
    id: 'desktop',
    label: '桌面通知',
    description: '通过浏览器显示系统桌面通知。',
  },
  {
    id: 'sound',
    label: '提示音',
    description: '应用页面打开时播放，入场与离场使用不同声音。',
  },
] as const;

export function strategyNotifications(
  value?: StrategyNotifications,
): StrategyNotifications {
  return {
    channels: {
      ...Object.fromEntries(
        STRATEGY_NOTIFICATION_CHANNELS.map(({ id }) => [
          id,
          { enabled: false },
        ]),
      ),
      ...value?.channels,
    },
  };
}
