import { useId } from 'react';
import { Button, Label, Switch, useDesktopPush } from '@app/plugin-ui';
import {
  STRATEGY_NOTIFICATION_CHANNELS,
  type StrategyNotifications,
} from '../../strategy-notifications';

export function StrategyNotificationSettings({
  value,
  onChange,
  disabled = false,
}: {
  value: StrategyNotifications;
  onChange: (value: StrategyNotifications) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const push = useDesktopPush();
  const desktop = value.channels.desktop?.enabled ?? false;
  const setChannel = (channel: string, enabled: boolean) =>
    onChange({
      ...value,
      channels: {
        ...value.channels,
        [channel]: { ...value.channels[channel], enabled },
      },
    });
  return (
    <fieldset disabled={disabled} className="min-w-0 border-t pt-4">
      <legend className="sr-only">通知设置</legend>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">通知设置</h3>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        出现新的入场与离场信号时，按以下方式通知。
      </p>
      <div className="mt-2 divide-y">
        {STRATEGY_NOTIFICATION_CHANNELS.map((channel) => (
          <div
            key={channel.id}
            className="flex items-center justify-between gap-4 py-3"
          >
            <div className="min-w-0 space-y-1">
              <Label htmlFor={`${id}-${channel.id}`}>{channel.label}</Label>
              <p
                id={`${id}-${channel.id}-hint`}
                className="text-xs leading-5 text-muted-foreground"
              >
                {channel.description}
              </p>
            </div>
            <Switch
              id={`${id}-${channel.id}`}
              aria-describedby={`${id}-${channel.id}-hint`}
              checked={value.channels[channel.id]?.enabled ?? false}
              disabled={
                disabled ||
                (channel.id === 'desktop' &&
                  (push.busy ||
                    (!desktop && (!push.supported || !push.publicKey))))
              }
              onCheckedChange={async (enabled) => {
                if (
                  channel.id === 'desktop' &&
                  enabled &&
                  !(await push.enable())
                )
                  return;
                setChannel(channel.id, enabled);
              }}
            />
          </div>
        ))}
      </div>
      {!push.supported ? (
        <p className="text-xs leading-5 text-muted-foreground">
          桌面通知需要支持通知的浏览器，并通过 HTTPS 或 localhost 访问。
        </p>
      ) : push.publicKey === null ? (
        <p className="text-xs leading-5 text-muted-foreground">
          服务器尚未配置桌面推送，前台 Toast 仍可使用。
        </p>
      ) : desktop && !push.registered ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || push.busy || !push.publicKey}
          onClick={() => void push.enable()}
        >
          在此浏览器启用桌面通知
        </Button>
      ) : null}
      {push.error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {push.error === 'notifications.denied'
            ? '通知权限已被阻止，请在浏览器的网站设置中允许通知后重试。'
            : '无法启用桌面通知，请检查浏览器权限与服务器推送配置。'}
        </p>
      )}
    </fieldset>
  );
}
