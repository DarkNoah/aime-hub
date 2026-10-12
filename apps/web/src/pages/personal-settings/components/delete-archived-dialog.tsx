import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ThreadSummary } from '@aime/shared/threads';
import { chatApi } from '@/components/chat/api';
import { archiveErrorKey } from '../errors';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function DeleteArchivedDialog({
  thread,
  onClose,
  onDeleted,
}: {
  thread: ThreadSummary;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  async function remove() {
    if (pending) return;
    setPending(true);
    try {
      await chatApi.removeArchived(thread.id);
      onDeleted();
      toast.success(t('personalSettings.deleted'));
      onClose();
    } catch (cause) {
      toast.error(t(archiveErrorKey(cause)));
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('personalSettings.delete')}</DialogTitle>
          <DialogDescription>
            {t('personalSettings.deleteHint')}
          </DialogDescription>
        </DialogHeader>
        <p
          className="truncate py-3 font-medium"
          title={thread.title || t('chat.new')}
        >
          {thread.title || t('chat.new')}
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            autoFocus
            disabled={pending}
            onClick={onClose}
          >
            {t('users.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void remove()}
          >
            {pending && <LoaderCircle className="animate-spin" />}
            {t(pending ? 'users.saving' : 'personalSettings.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
