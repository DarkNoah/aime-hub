import { useState, type FormEvent } from 'react';
import { Loader2, Pencil, Type } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  systemSettingsUpdateSchema,
  type SystemSettingsUpdate,
} from '@aime/shared/system-settings';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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

type Props = {
  appName: string;
  saving: boolean;
  onSave: (patch: SystemSettingsUpdate) => Promise<boolean>;
};

export function AppNameSettings({ appName, saving, onSave }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(appName);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const parsed = systemSettingsUpdateSchema.safeParse({ appName: draft });
    if (!parsed.success) {
      toast.error(t('settings.appNameInvalid'));
      return;
    }
    if (await onSave(parsed.data)) setEditing(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Type className="size-4 text-muted-foreground" />
          {t('settings.appName')}
        </CardTitle>
        <CardDescription>{t('settings.appNameHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
          <p className="min-w-0 truncate text-sm font-medium" title={appName}>
            {appName}
          </p>
          <Button
            variant="outline"
            className="shrink-0"
            disabled={saving}
            onClick={() => {
              setDraft(appName);
              setEditing(true);
            }}
          >
            <Pencil />
            {t('settings.appNameEdit')}
          </Button>
        </div>
        <Dialog
          open={editing}
          onOpenChange={(open) => {
            if (!saving) setEditing(open);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('settings.appNameEdit')}</DialogTitle>
              <DialogDescription>{t('settings.appNameHint')}</DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => void submit(event)}
              className="space-y-5"
              aria-busy={saving}
            >
              <div className="space-y-2">
                <Label htmlFor="app-name">{t('settings.appName')}</Label>
                <Input
                  id="app-name"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={80}
                  required
                  disabled={saving}
                  aria-describedby="app-name-hint"
                />
                <p id="app-name-hint" className="text-xs text-muted-foreground">
                  {t('settings.appNameLimit')}
                </p>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => setEditing(false)}
                >
                  {t('settings.cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={saving || !draft.trim() || draft.trim() === appName}
                >
                  {saving && <Loader2 className="animate-spin" />}
                  {t('settings.save')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
