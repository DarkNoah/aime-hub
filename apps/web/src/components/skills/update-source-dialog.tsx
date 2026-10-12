import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import type { InstalledSkill } from '@aime/shared/skills';
import type { TranslationKey } from '@/i18n/config';
import { Button } from '@/components/ui/button';
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
import {
  getSkillApi,
  isSkillSourceInput,
  skillErrorKey,
  type SkillScope,
} from './api';

export function UpdateSourceDialog({
  scope,
  group,
  onClose,
  onUpdated,
}: {
  scope: SkillScope;
  group: string;
  onClose: () => void;
  onUpdated: (skills: InstalledSkill[]) => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  async function update() {
    if (pending) return;
    if (!isSkillSourceInput(source)) {
      setError('skills.invalidUrl');
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const skills = await getSkillApi(scope).updateGroup({
        body: { group, source: source.trim() },
      });
      onUpdated(skills);
      onClose();
    } catch (cause) {
      setError(skillErrorKey(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{t('skills.restoreSourceTitle')}</DialogTitle>
          <DialogDescription>{t('skills.sourceUnknown')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void update();
          }}
        >
          <p className="break-all text-sm font-medium">{group}</p>
          <div className="space-y-2">
            <Label htmlFor="skill-update-source">{t('skills.source')}</Label>
            <Input
              id="skill-update-source"
              autoFocus
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setError(undefined);
              }}
              disabled={pending}
              placeholder={`https://github.com/${group}/tree/main/skills`}
              aria-invalid={!!error}
              aria-describedby={error ? 'skill-update-error' : undefined}
            />
            {error ? (
              <p
                id="skill-update-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {t(error)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('skills.cancel')}
            </Button>
            <Button type="submit" disabled={pending || !source.trim()}>
              {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t(pending ? 'skills.updatingGroup' : 'skills.updateGroup')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
