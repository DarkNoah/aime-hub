import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share2, Link2Off, Loader2 } from 'lucide-react';
import type {
  InstalledSkill,
  SkillDestination,
  SkillSharingOptions,
  SkillSharing,
} from '@aime/shared/skills';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function ShareSkillDialog({
  skill,
  sharing,
  pending,
  onClose,
  onShare,
  onUnshare,
  published,
}: {
  skill: InstalledSkill;
  sharing: SkillSharingOptions;
  pending: boolean;
  onClose: () => void;
  onShare: (target: SkillDestination) => void;
  onUnshare: (target: SkillDestination) => void;
  published: SkillSharing[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const [destination, setDestination] = useState('');
  const destinations = new Set(
    published.map((item) =>
      item.scope === 'global' ? 'global' : item.projectId,
    ),
  );
  const global = sharing.global && !destinations.has('global');
  const projects = sharing.projects.filter(
    (item) => !destinations.has(item.id),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {t('skills.shareNamed', { name: skill.projectRoot || skill.name })}
          </DialogTitle>
          <DialogDescription>
            {t(
              skill.projectRoot ? 'skills.shareWholeHint' : 'skills.shareHint',
            )}
          </DialogDescription>
        </DialogHeader>
        {published.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('skills.sharedLocations')}</p>
            <ScrollArea
              className="max-h-40"
              viewportProps={{ className: 'max-h-40' }}
            >
              <ul className="divide-y rounded-md border">
                {published.map((item) => {
                  const name =
                    item.scope === 'global'
                      ? t('skills.globalDestination')
                      : (item.projectName ?? item.projectId);
                  return (
                    <li
                      key={item.scope === 'global' ? 'global' : item.projectId}
                      className="flex items-center justify-between gap-2 px-3 py-1.5"
                    >
                      <span className="min-w-0 truncate text-sm" title={name}>
                        {name}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        aria-label={t('skills.stopSharingNamed', { name })}
                        onClick={() => onUnshare(item)}
                      >
                        <Link2Off />
                        {t('skills.stopSharing')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          </div>
        )}
        {(global || projects.length > 0) && (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!destination || pending) return;
              onShare(
                destination === 'global'
                  ? { scope: 'global' }
                  : { scope: 'project', projectId: destination },
              );
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={id}>{t('skills.shareDestination')}</Label>
              <Select
                value={destination}
                onValueChange={setDestination}
                disabled={pending}
              >
                <SelectTrigger id={id} className="w-full">
                  <SelectValue placeholder={t('skills.chooseDestination')} />
                </SelectTrigger>
                <SelectContent>
                  {global && (
                    <SelectItem value="global">
                      {t('skills.globalDestination')}
                    </SelectItem>
                  )}
                  {projects.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>{t('nav.projects')}</SelectLabel>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
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
              <Button type="submit" disabled={!destination || pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Share2 />}
                {t('skills.share')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
