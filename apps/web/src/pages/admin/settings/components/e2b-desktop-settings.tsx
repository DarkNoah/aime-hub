import { useState, type FormEvent } from 'react';
import { Loader2, Monitor, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  systemSettingsUpdateSchema,
  type SystemSettings,
  type SystemSettingsUpdate,
} from '@aime/shared/system-settings';
import { PasswordInput } from '@/components/password-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/rpc';
import { toast } from 'sonner';
import { DesktopManager } from './desktop-manager';
import { desktopErrorKey } from './desktop-errors';

type Props = {
  settings: SystemSettings;
  saving: boolean;
  onSave: (patch: SystemSettingsUpdate) => Promise<boolean>;
};

export function E2BDesktopSettings({ settings, saving, onSave }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ enabled: boolean } | null>(null);
  const [managing, setManaging] = useState(false);
  const [testing, setTesting] = useState(false);
  const configured = Boolean(
    settings.e2bDesktopApiUrl &&
    settings.e2bDesktopHasApiKey &&
    settings.e2bDesktopTemplate,
  );

  async function testConnection() {
    if (testing) return;
    setTesting(true);
    try {
      await api.systemSettings.desktop.test();
      toast.success(t('settings.desktopConnected'));
    } catch (error) {
      toast.error(t(desktopErrorKey(error)));
    } finally {
      setTesting(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Monitor className="size-4 text-muted-foreground" />
          E2B Desktop
          {settings.e2bDesktopManaged && (
            <Badge variant="outline">{t('settings.desktopManaged')}</Badge>
          )}
        </CardTitle>
        <CardDescription>{t('settings.desktopDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings.e2bDesktopManaged && (
          <p className="text-sm text-muted-foreground">
            {t('settings.desktopManagedHint', {
              template: settings.e2bDesktopTemplate,
              seconds: settings.e2bDesktopTimeoutSeconds,
            })}
          </p>
        )}
        <div
          className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
          aria-busy={saving}
        >
          <Label htmlFor="desktop-enabled" className="flex-1 leading-6">
            {t('settings.desktopEnabled')}
          </Label>
          <div className="flex items-center gap-3">
            <Badge
              variant={settings.e2bDesktopEnabled ? 'secondary' : 'outline'}
            >
              {t(
                settings.e2bDesktopEnabled
                  ? 'settings.requestLoggingEnabled'
                  : 'settings.requestLoggingDisabled',
              )}
            </Badge>
            <Switch
              id="desktop-enabled"
              checked={settings.e2bDesktopEnabled}
              disabled={saving || testing || settings.e2bDesktopManaged}
              onCheckedChange={(enabled) => {
                if (enabled && !configured) setEditing({ enabled });
                else void onSave({ e2bDesktopEnabled: enabled });
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 break-all text-sm text-muted-foreground">
            {settings.e2bDesktopApiUrl || t('settings.desktopNotConfigured')}
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={saving || testing || settings.e2bDesktopManaged}
              onClick={() =>
                setEditing({ enabled: settings.e2bDesktopEnabled })
              }
            >
              <Settings2 />
              {t('settings.desktopConfigure')}
            </Button>
            <Button
              variant="outline"
              disabled={saving || testing || !configured}
              onClick={() => void testConnection()}
            >
              {testing && <Loader2 className="animate-spin" />}
              {t('settings.desktopTest')}
            </Button>
            <Button
              disabled={saving || testing || !settings.e2bDesktopEnabled}
              onClick={() => setManaging(true)}
            >
              {t('settings.desktopManage')}
            </Button>
          </div>
        </div>
        {managing && (
          <DesktopManager
            settings={settings}
            onClose={() => setManaging(false)}
          />
        )}
        {editing && (
          <DesktopSettingsDialog
            settings={settings}
            initialEnabled={editing.enabled}
            saving={saving}
            onSave={onSave}
            onClose={() => setEditing(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function DesktopSettingsDialog({
  settings,
  initialEnabled,
  saving,
  onSave,
  onClose,
}: Props & { initialEnabled: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [url, setUrl] = useState(settings.e2bDesktopApiUrl);
  const [template, setTemplate] = useState(settings.e2bDesktopTemplate);
  const [timeout, setTimeout] = useState(
    String(settings.e2bDesktopTimeoutSeconds),
  );
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [invalid, setInvalid] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const parsed = systemSettingsUpdateSchema.safeParse({
      e2bDesktopEnabled: enabled,
      e2bDesktopApiUrl: url,
      e2bDesktopTemplate: template,
      e2bDesktopTimeoutSeconds: Number(timeout),
      ...(clearApiKey
        ? { e2bDesktopApiKey: null }
        : apiKey
          ? { e2bDesktopApiKey: apiKey }
          : {}),
    });
    if (
      !parsed.success ||
      (enabled &&
        (!url.trim() ||
          !template.trim() ||
          !(apiKey.trim() || (!clearApiKey && settings.e2bDesktopHasApiKey))))
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (await onSave(parsed.data)) onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.desktopConfigure')}</DialogTitle>
          <DialogDescription>
            {t('settings.desktopConfigHint')}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => void submit(event)}
          className="min-w-0 space-y-5"
          aria-busy={saving}
        >
          <ScrollArea
            className="max-h-[60dvh]"
            viewportProps={{ className: 'max-h-[60dvh]' }}
          >
            <div className="space-y-5 px-1 py-1">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="desktop-dialog-enabled">
                  {t('settings.desktopEnabled')}
                </Label>
                <Switch
                  id="desktop-dialog-enabled"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={saving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="desktop-url">{t('settings.desktopUrl')}</Label>
                <Input
                  id="desktop-url"
                  type="url"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setInvalid(false);
                  }}
                  placeholder="http://e2b.internal:3000"
                  disabled={saving}
                  required={enabled}
                  aria-invalid={invalid}
                  aria-describedby={
                    invalid
                      ? 'desktop-url-hint desktop-error'
                      : 'desktop-url-hint'
                  }
                />
                <p
                  id="desktop-url-hint"
                  className="text-sm text-muted-foreground"
                >
                  {t('settings.desktopUrlHint')}
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="desktop-apiKey">
                    {t('settings.desktopApiKey')}
                  </Label>
                  {settings.e2bDesktopHasApiKey && (
                    <Badge variant="secondary">
                      {t('settings.desktopApiKeyConfigured')}
                    </Badge>
                  )}
                </div>
                <PasswordInput
                  id="desktop-apiKey"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={saving || clearApiKey}
                  autoComplete="new-password"
                  placeholder={
                    settings.e2bDesktopHasApiKey
                      ? t('settings.desktopApiKeyKeep')
                      : ''
                  }
                  aria-describedby="desktop-apiKey-hint"
                />
                <p
                  id="desktop-apiKey-hint"
                  className="text-sm text-muted-foreground"
                >
                  {t('settings.desktopApiKeyHint')}
                </p>
                {settings.e2bDesktopHasApiKey && (
                  <div className="flex items-center gap-2 pt-1">
                    <Checkbox
                      id="desktop-clear-apiKey"
                      checked={clearApiKey}
                      onCheckedChange={(value) =>
                        setClearApiKey(value === true)
                      }
                      disabled={saving}
                    />
                    <Label htmlFor="desktop-clear-apiKey">
                      {t('settings.desktopClearApiKey')}
                    </Label>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="desktop-template">
                  {t('settings.desktopTemplate')}
                </Label>
                <Input
                  id="desktop-template"
                  value={template}
                  onChange={(event) => setTemplate(event.target.value)}
                  disabled={saving}
                  required={enabled}
                  placeholder="desktop"
                />
                <p className="text-sm text-muted-foreground">
                  {t('settings.desktopTemplateHint')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="desktop-timeout">
                  {t('settings.desktopTimeout')}
                </Label>
                <Input
                  id="desktop-timeout"
                  type="number"
                  value={timeout}
                  onChange={(event) => setTimeout(event.target.value)}
                  disabled={saving}
                  required
                />
              </div>
              {invalid && (
                <p
                  id="desktop-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {t('settings.desktopInvalid')}
                </p>
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onClose}
            >
              {t('settings.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {t('settings.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
