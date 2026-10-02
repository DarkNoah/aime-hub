import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ProjectSummary } from '@aime/shared/projects';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { chatErrorKey } from '@/components/chat/api';
import { projectApi } from '../api';

export function ProjectSheet({
  project,
  onClose,
  onSaved,
}: {
  project?: ProjectSummary;
  onClose: () => void;
  onSaved: (value: ProjectSummary) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(project?.name ?? '');
  const [pending, setPending] = useState(false);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <SheetContent closeLabel={t('common.close')}>
        <div className="space-y-2 p-6 pr-12">
          <SheetTitle>
            {t(project ? 'projects.edit' : 'projects.create')}
          </SheetTitle>
          <SheetDescription>{t('projects.nameHint')}</SheetDescription>
        </div>
        <form
          className="space-y-6 px-6 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            setPending(true);
            void (
              project
                ? projectApi.update(project.id, name.trim())
                : projectApi.create(name.trim())
            )
              .then((value) => {
                onSaved(value);
                toast.success(t('projects.saved'));
                onClose();
              })
              .catch((cause) => toast.error(t(chatErrorKey(cause))))
              .finally(() => setPending(false));
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="project-name">{t('projects.name')}</Label>
            <Input
              id="project-name"
              autoFocus
              maxLength={120}
              required
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('users.cancel')}
            </Button>
            <Button disabled={pending || !name.trim()}>
              {t(pending ? 'users.saving' : 'users.save')}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
