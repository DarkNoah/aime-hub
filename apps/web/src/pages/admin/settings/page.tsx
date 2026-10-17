import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ScrollText, ShieldCheck } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type {
  SystemSettings,
  SystemSettingsUpdate,
} from '@aime/shared/system-settings';
import { api, apiErrorCode } from '@/lib/rpc';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { E2BDesktopSettings } from './components/e2b-desktop-settings';

export function AdminSettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SystemSettings>();
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const changing = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void api.systemSettings.get(undefined, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) {
          setSettings(value);
          setLoadError(false);
        }
      },
      () => {
        if (!controller.signal.aborted) setLoadError(true);
      },
    );
    return () => controller.abort();
  }, [revision]);

  async function updateSettings(body: SystemSettingsUpdate) {
    if (!settings || changing.current) return false;
    changing.current = true;
    setSaving(true);
    try {
      setSettings(await api.systemSettings.update({ body }));
      toast.success(t('settings.saved'));
      return true;
    } catch (cause) {
      const code = apiErrorCode(cause);
      toast.error(
        t(
          code === 'UNAUTHORIZED'
            ? 'errors.sessionExpired'
            : code === 'FORBIDDEN'
              ? 'errors.forbidden'
              : code === 'VALIDATION_ERROR'
                ? 'settings.desktopInvalid'
                : code === 'E2B_MANAGED_CONFIG'
                  ? 'settings.desktopManagedError'
                  : 'errors.request',
        ),
      );
      return false;
    } finally {
      changing.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('nav.settings')}
        description={t('admin.settingsDescription')}
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" />
            {t('settings.registrationTitle')}
          </CardTitle>
          <CardDescription>{t('settings.registrationHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-sm text-destructive"
            >
              <span>{t('errors.request')}</span>
              <Button
                variant="outline"
                onClick={() => {
                  setLoadError(false);
                  setRevision((value) => value + 1);
                }}
              >
                {t('settings.retry')}
              </Button>
            </div>
          ) : settings ? (
            <div
              className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
              aria-busy={saving}
            >
              <Label
                htmlFor="registration-enabled"
                className="flex-1 leading-6"
              >
                {t('settings.allowRegistration')}
              </Label>
              <div className="flex items-center gap-3">
                <Badge
                  variant={
                    settings.registrationEnabled ? 'secondary' : 'outline'
                  }
                >
                  {t(
                    settings.registrationEnabled
                      ? 'settings.registrationEnabled'
                      : 'settings.registrationDisabled',
                  )}
                </Badge>
                <Switch
                  id="registration-enabled"
                  checked={settings.registrationEnabled}
                  disabled={saving}
                  onCheckedChange={(value) =>
                    void updateSettings({ registrationEnabled: value })
                  }
                />
              </div>
            </div>
          ) : (
            <LoadingState />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="size-4 text-muted-foreground" />
            {t('nav.requestLogs')}
          </CardTitle>
          <CardDescription id="request-logging-hint">
            {t('settings.requestLoggingHint')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settings ? (
            <div
              className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
              aria-busy={saving}
            >
              <Label
                htmlFor="request-logging-enabled"
                className="flex-1 leading-6"
              >
                {t('settings.requestLogging')}
              </Label>
              <div className="flex items-center gap-3">
                <Badge
                  variant={
                    settings.requestLoggingEnabled ? 'secondary' : 'outline'
                  }
                >
                  {t(
                    settings.requestLoggingEnabled
                      ? 'settings.requestLoggingEnabled'
                      : 'settings.requestLoggingDisabled',
                  )}
                </Badge>
                <Switch
                  id="request-logging-enabled"
                  aria-describedby="request-logging-hint"
                  checked={settings.requestLoggingEnabled}
                  disabled={saving || loadError}
                  onCheckedChange={(value) =>
                    void updateSettings({ requestLoggingEnabled: value })
                  }
                />
              </div>
            </div>
          ) : loadError ? (
            <p className="text-sm text-muted-foreground">
              {t('errors.request')}
            </p>
          ) : (
            <LoadingState />
          )}
        </CardContent>
      </Card>
      {settings && (
        <E2BDesktopSettings
          settings={settings}
          saving={saving || loadError}
          onSave={updateSettings}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.settingsTitle')}</CardTitle>
          <CardDescription>{t('admin.settingsHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link to="/admin/providers">
              {t('defaults.title')}
              <ArrowUpRight />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
