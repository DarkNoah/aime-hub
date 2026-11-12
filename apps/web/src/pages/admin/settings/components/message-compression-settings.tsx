import { useState, type FormEvent } from 'react';
import { Loader2, Minimize2, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  defaultSystemSettings,
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
  tokens: number;
  saving: boolean;
  onSave: (patch: SystemSettingsUpdate) => Promise<boolean>;
};

export function MessageCompressionSettings({ tokens, saving, onSave }: Props) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(tokens));
  const parsed = systemSettingsUpdateSchema.safeParse({
    messageCompressionTokens: Number(draft),
  });
  const hint = t('settings.messageCompressionHint', {
    tokens: defaultSystemSettings.messageCompressionTokens.toLocaleString(
      i18n.language,
    ),
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (!parsed.success) {
      toast.error(t('settings.messageCompressionInvalid'));
      return;
    }
    if (await onSave(parsed.data)) setEditing(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Minimize2 className="size-4 text-muted-foreground" />
          {t('settings.messageCompression')}
        </CardTitle>
        <CardDescription>{hint}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {t('settings.messageCompressionThreshold')}
            </p>
            <p className="text-sm text-muted-foreground tabular-nums">
              {tokens.toLocaleString(i18n.language)} tokens
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0"
            disabled={saving}
            onClick={() => {
              setDraft(String(tokens));
              setEditing(true);
            }}
          >
            <Pencil />
            {t('settings.messageCompressionEdit')}
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
              <DialogTitle>{t('settings.messageCompressionEdit')}</DialogTitle>
              <DialogDescription>{hint}</DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => void submit(event)}
              className="space-y-5"
              aria-busy={saving}
            >
              <div className="space-y-2">
                <Label htmlFor="message-compression-tokens">
                  {t('settings.messageCompressionThreshold')} (tokens)
                </Label>
                <Input
                  id="message-compression-tokens"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  required
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={saving}
                  aria-describedby="message-compression-hint"
                />
                <p
                  id="message-compression-hint"
                  className="text-xs text-muted-foreground"
                >
                  {t('settings.messageCompressionEffect')}
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
                  disabled={
                    saving || !parsed.success || Number(draft) === tokens
                  }
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
