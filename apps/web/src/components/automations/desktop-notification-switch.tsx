import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { useDesktopPush } from '@/features/notifications/use-desktop-push';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

export function DesktopNotificationSwitch({
  checked,
  onCheckedChange,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const {
    publicKey,
    busy,
    error,
    registered,
    supported,
    enable: register,
  } = useDesktopPush();
  async function enable() {
    if (await register()) onCheckedChange(true);
  }
  return (
    <div className="space-y-2 border-t pt-5">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={id}>{t('notifications.desktop')}</Label>
        <Switch
          id={id}
          checked={checked}
          disabled={
            disabled || busy || (!checked && (!supported || !publicKey))
          }
          aria-describedby={`${id}-hint`}
          onCheckedChange={(value) =>
            value ? void enable() : onCheckedChange(false)
          }
        />
      </div>
      <p id={`${id}-hint`} className="text-xs leading-5 text-muted-foreground">
        {t('notifications.desktopHint')}
      </p>
      {!supported ? (
        <p className="text-xs text-muted-foreground">
          {t('notifications.unsupported')}
        </p>
      ) : publicKey === null ? (
        <p className="text-xs text-muted-foreground">
          {t('notifications.notConfigured')}
        </p>
      ) : (
        checked &&
        !registered && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || disabled || !publicKey}
            onClick={() => void enable()}
          >
            {t('notifications.enableBrowser')}
          </Button>
        )
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t(error)}
        </p>
      )}
    </div>
  );
}

// Members can opt their own browser in without permission to edit project tasks.
export function BrowserPushEnrollment() {
  const { t } = useTranslation();
  const { publicKey, busy, error, registered, supported, enable } =
    useDesktopPush();
  if (!supported || !publicKey || registered) return null;
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void enable()}
      >
        <Bell />
        {t('notifications.enableBrowser')}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t(error)}
        </p>
      )}
    </div>
  );
}
