import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ThreadSummary } from '@aime/shared/threads';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { chatApi, chatErrorKey } from '@/components/chat/api';

export function ThreadDialog({
  thread,
  mode,
  onClose,
  onSaved,
  onDeleted,
}: {
  thread: ThreadSummary;
  mode: 'rename' | 'delete';
  onClose: () => void;
  onSaved: (thread: ThreadSummary) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(thread.title);
  const [pending, setPending] = useState(false);
  const archive = mode === 'delete' && !thread.projectId;
  const actionLabel =
    mode === 'rename'
      ? 'chat.rename'
      : archive
        ? 'chat.archive'
        : 'chat.delete';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            setPending(true);
            void (async () => {
              try {
                if (mode === 'rename')
                  onSaved(
                    await chatApi.update(thread.id, { title: title.trim() }),
                  );
                else {
                  await chatApi.remove(thread.id);
                  onDeleted();
                }
                toast.success(
                  t(
                    mode === 'rename'
                      ? 'chat.renamed'
                      : archive
                        ? 'chat.archived'
                        : 'chat.deleted',
                  ),
                );
                onClose();
              } catch (cause) {
                toast.error(t(chatErrorKey(cause)));
              } finally {
                setPending(false);
              }
            })();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(actionLabel)}</DialogTitle>
            <DialogDescription>
              {t(
                mode === 'rename'
                  ? 'chat.renameHint'
                  : archive
                    ? 'chat.archiveHint'
                    : 'chat.deleteHint',
              )}
            </DialogDescription>
          </DialogHeader>
          {mode === 'rename' ? (
            <div className="my-5 space-y-2">
              <Label htmlFor="thread-title">{t('chat.title')}</Label>
              <Input
                id="thread-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                required
                disabled={pending}
              />
            </div>
          ) : (
            <p className="my-5 truncate font-medium">
              {thread.title || t('chat.new')}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={pending}
            >
              {t('users.cancel')}
            </Button>
            <Button
              type="submit"
              className={
                mode === 'delete' && !archive
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : undefined
              }
              disabled={pending || (mode === 'rename' && !title.trim())}
            >
              {t(
                pending
                  ? 'users.saving'
                  : mode === 'rename'
                    ? 'users.save'
                    : actionLabel,
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
