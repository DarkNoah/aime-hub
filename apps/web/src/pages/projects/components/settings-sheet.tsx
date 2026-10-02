import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ProjectDetail } from '@aime/shared/projects';
import type { ChatSettings } from '@aime/shared/threads';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ModelSelector } from '@/components/model-selector';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { reasoningEfforts } from '@aime/shared/threads';
import { chatErrorKey } from '@/components/chat/api';
import { projectApi } from '../api';

export function SettingsSheet({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectDetail;
  onClose: () => void;
  onSaved: (settings: ChatSettings) => void;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(project.settings);
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
          <SheetTitle>{t('projects.settings')}</SheetTitle>
          <SheetDescription>{t('projects.settingsHint')}</SheetDescription>
        </div>
        <form
          className="space-y-6 px-6 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            setPending(true);
            void projectApi
              .savePreferences(project.id, settings)
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
            <Label htmlFor="project-model">{t('chat.model')}</Label>
            <ModelSelector
              id="project-model"
              label={t('chat.model')}
              textOnly
              value={settings.model}
              noneLabel={t('chat.defaultModel')}
              disabled={pending}
              onValueChange={(model) =>
                setSettings((current) => ({ ...current, model }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-reasoning">
              {t('chat.reasoningLevel')}
            </Label>
            <Select
              disabled={pending}
              value={settings.reasoningEffort}
              onValueChange={(
                reasoningEffort: ChatSettings['reasoningEffort'],
              ) => setSettings((current) => ({ ...current, reasoningEffort }))}
            >
              <SelectTrigger id="project-reasoning" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {reasoningEfforts.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {t(`chat.reasoning.${effort}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <Button disabled={pending}>
              {t(pending ? 'users.saving' : 'users.save')}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
