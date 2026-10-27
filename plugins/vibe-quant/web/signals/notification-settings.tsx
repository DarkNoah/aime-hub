import { useId, useState } from 'react';
import { Volume2 } from 'lucide-react';
import {
  Button,
  Label,
  Switch,
  useDesktopPush,
  enableNotificationSound,
  previewNotificationSound,
  notificationSoundSupported,
} from '@app/plugin-ui';
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
  const [soundError, setSoundError] = useState('');
  const [soundBusy, setSoundBusy] = useState(false);
  const soundSupported = notificationSoundSupported();
  async function preview(sound: 'entry' | 'exit') {
    setSoundBusy(true);
    setSoundError('');
    try {
      if (!(await previewNotificationSound(sound)))
        setSoundError('无法播放提示音，请检查浏览器声音设置后重试。');
    } finally {
      setSoundBusy(false);
    }
  }
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
    <fieldset
      disabled={disabled || soundBusy}
      className="min-w-0 border-t pt-4"
    >
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
              {channel.id === 'sound' && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || soundBusy || !soundSupported}
                    onClick={() => void preview('entry')}
                  >
                    <Volume2 className="size-3.5" />
                    试听入场
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || soundBusy || !soundSupported}
                    onClick={() => void preview('exit')}
                  >
                    <Volume2 className="size-3.5" />
                    试听离场
                  </Button>
                </div>
              )}
            </div>
            <Switch
              id={`${id}-${channel.id}`}
              aria-describedby={`${id}-${channel.id}-hint`}
              checked={value.channels[channel.id]?.enabled ?? false}
              disabled={
                disabled ||
                soundBusy ||
                (channel.id === 'sound' &&
                  !soundSupported &&
                  !value.channels.sound?.enabled) ||
                (channel.id === 'desktop' &&
                  (push.busy ||
                    (!desktop && (!push.supported || !push.publicKey))))
              }
              onCheckedChange={async (enabled) => {
                if (channel.id === 'sound' && enabled) {
                  setSoundBusy(true);
                  setSoundError('');
                  const ready = await enableNotificationSound();
                  setSoundBusy(false);
                  if (!ready) {
                    setSoundError(
                      '无法启用提示音，请检查浏览器声音设置后重试。',
                    );
                    return;
                  }
                }
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
      {soundError && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {soundError}
        </p>
      )}
      {soundSupported ? (
        <p className="mb-2 text-xs leading-5 text-muted-foreground">
          刷新页面后，请先点击页面或试听以启用声音。关闭所有应用页面后，桌面通知声音由系统控制。
        </p>
      ) : (
        <p className="mb-2 text-xs leading-5 text-muted-foreground">
          当前浏览器不支持页面提示音。
        </p>
      )}
      {!push.supported ? (
        <p className="text-xs leading-5 text-muted-foreground">
          桌面通知需要支持通知的浏览器，并通过 HTTPS 或 localhost 访问。
        </p>
      ) : push.publicKey === null ? (
        <p className="text-xs leading-5 text-muted-foreground">
          服务器尚未配置桌面推送，前台 Toast 和提示音仍可使用。
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
