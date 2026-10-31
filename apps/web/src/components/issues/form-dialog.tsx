import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { issueStates, type Issue, type IssueState } from '@aime/shared/issues';
import type { ChatSettings } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { issueApi, issueChanged, issueErrorKey } from './api';

export function IssueFormDialog({
  issue,
  projectId,
  settings,
  onClose,
  onSaved,
}: {
  issue?: Issue;
  projectId?: string;
  settings?: ChatSettings;
  onClose: () => void;
  onSaved?: (issue: Issue) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [title, setTitle] = useState(issue?.title ?? '');
  const [body, setBody] = useState(issue?.body ?? '');
  const [state, setState] = useState<IssueState>(issue?.state ?? 'todo');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t(issue ? 'issues.edit' : 'issues.create')}
          </DialogTitle>
          <DialogDescription>{t('issues.createHint')}</DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !title.trim()) return;
            setBusy(true);
            const data = { title: title.trim(), body, state };
            void (
              issue
                ? issueApi.edit({ id: issue.id, projectId, data })
                : issueApi.create({ projectId, data: { ...data, settings } })
            )
              .then((result) => {
                issueChanged();
                toast.success(t(issue ? 'issues.saved' : 'issues.created'));
                onSaved?.(result);
                onClose();
              })
              .catch((cause) => toast.error(t(issueErrorKey(cause))))
              .finally(() => setBusy(false));
          }}
        >
          <ScrollArea
            className="max-h-[65dvh]"
            viewportProps={{ className: 'max-h-[65dvh]' }}
          >
            <div className="space-y-4 px-1 pb-1">
              <div className="space-y-2">
                <Label htmlFor={`${id}-title`}>{t('issues.titleField')}</Label>
                <Input
                  id={`${id}-title`}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={240}
                  autoFocus
                  disabled={busy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-body`}>{t('issues.body')}</Label>
                <Textarea
                  id={`${id}-body`}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={8}
                  maxLength={50000}
                  placeholder={t('issues.bodyPlaceholder')}
                  disabled={busy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-state`}>{t('issues.status')}</Label>
                <Select
                  value={state}
                  onValueChange={(value) => setState(value as IssueState)}
                  disabled={busy}
                >
                  <SelectTrigger id={`${id}-state`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {issueStates.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`issues.state.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {t('users.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {t(
                busy ? 'users.saving' : issue ? 'issues.save' : 'issues.create',
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
