import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ChatSettings, ThreadSummary } from '@aime/shared/threads';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ChatSettingsFields } from '@/components/chat/chat-settings';
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
                  t(mode === 'rename' ? 'chat.renamed' : 'chat.deleted'),
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
            <DialogTitle>
              {t(mode === 'rename' ? 'chat.rename' : 'chat.delete')}
            </DialogTitle>
            <DialogDescription>
              {mode === 'delete' ? t('chat.deleteHint') : t('chat.renameHint')}
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
                mode === 'delete'
                  ? 'bg-destructive text-white hover:bg-destructive/90'
                  : undefined
              }
              disabled={pending || (mode === 'rename' && !title.trim())}
            >
              {t(
                pending
                  ? 'users.saving'
                  : mode === 'rename'
                    ? 'users.save'
                    : 'chat.delete',
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PreferencesSheet({
  initial,
  onClose,
  onSaved,
}: {
  initial: ChatSettings;
  onClose: () => void;
  onSaved: (settings: ChatSettings) => void;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(initial);
  const [pending, setPending] = useState(false);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <SheetContent closeLabel={t('common.close')}>
        <div className="space-y-2 p-4 pr-10">
          <SheetTitle>{t('chat.preferences')}</SheetTitle>
          <SheetDescription>{t('chat.preferencesHint')}</SheetDescription>
        </div>
        <div className="p-4">
          <ChatSettingsFields
            value={settings}
            onChange={setSettings}
            disabled={pending}
          />
        </div>
        <div className="mt-auto p-4">
          <Button
            className="w-full"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void chatApi
                .savePreferences(settings)
                .then((value) => {
                  onSaved(value);
                  toast.success(t('chat.saved'));
                  onClose();
                })
                .catch((cause) => toast.error(t(chatErrorKey(cause))))
                .finally(() => setPending(false));
            }}
          >
            {t(pending ? 'users.saving' : 'users.save')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
