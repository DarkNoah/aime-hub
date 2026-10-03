import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
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
import { Button } from '@/components/ui/button';
import type { EntryAction } from './entry-actions';
import type { FileManagerState } from './use-file-manager';
import { validName } from './state';
import { fileErrorKey } from './api';

export function EntryDialog({
  action,
  state,
  onClose,
}: {
  action: EntryAction;
  state: FileManagerState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(
    action.operation === 'rename' ? action.entry.name : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof fileErrorKey> | null>(
    null,
  );
  const deleting = action.operation === 'delete';
  const label = t(`files.${action.operation}`);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            if (!deleting && !validName(name)) {
              setError('files.invalidName');
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await state.mutate(
                action.operation === 'delete'
                  ? { operation: 'delete', path: action.entry.path }
                  : action.operation === 'rename'
                    ? { operation: 'rename', path: action.entry.path, name }
                    : {
                        operation: 'create',
                        path: [action.entry.path, name]
                          .filter(Boolean)
                          .join('/'),
                        kind:
                          action.operation === 'createFolder'
                            ? 'directory'
                            : 'file',
                      },
              );
              toast.success(t(deleting ? 'files.deleted' : 'files.saved'));
              onClose();
            } catch (cause) {
              setError(fileErrorKey(cause));
              toast.error(t(fileErrorKey(cause)));
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription className="break-all">
              {deleting
                ? t('files.deleteHint', { path: action.entry.path })
                : action.entry.path || t('files.root')}
            </DialogDescription>
          </DialogHeader>
          {!deleting && (
            <div className="my-5 space-y-2">
              <Label htmlFor="file-entry-name">{t('files.name')}</Label>
              <Input
                autoFocus
                id="file-entry-name"
                value={name}
                maxLength={255}
                disabled={busy}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                aria-invalid={!!error}
                aria-describedby={error ? 'file-entry-error' : undefined}
              />
            </div>
          )}
          {error && (
            <p
              id="file-entry-error"
              role="alert"
              className="my-3 text-sm text-destructive"
            >
              {t(error)}
            </p>
          )}
          <DialogFooter className="mt-5">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {t('files.cancel')}
            </Button>
            <Button
              type="submit"
              variant={deleting ? 'destructive' : 'default'}
              disabled={busy}
            >
              {busy ? t('files.working') : label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
