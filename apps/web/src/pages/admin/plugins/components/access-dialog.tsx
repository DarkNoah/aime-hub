import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { PluginAccessConfiguration, PluginStatus } from '@app/plugin-sdk';
import { pluginRequest } from '@app/plugin-sdk/web';
import { AdminUserSelect } from '@/components/admin-user-select';
import { LoadingState } from '@/components/loading-state';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function PluginAccessDialog({
  plugin,
  onClose,
  restoreFocus,
}: {
  plugin: PluginStatus;
  onClose(): void;
  restoreFocus(): void;
}) {
  const { t } = useTranslation();
  const [configuration, setConfiguration] =
    useState<PluginAccessConfiguration>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void pluginRequest<PluginAccessConfiguration>(plugin.id, '/access', {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setConfiguration(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t('plugins.accessLoadFailed'));
      });
    return () => controller.abort();
  }, [plugin.id, revision, t]);
  const reload = () => {
    setError('');
    setConflict(false);
    setConfiguration(undefined);
    setRevision((current) => current + 1);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!configuration || saving.current || conflict) return;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await pluginRequest<PluginAccessConfiguration>(plugin.id, '/access', {
        method: 'PUT',
        body: JSON.stringify(configuration),
      });
      toast.success(t('plugins.accessSaved'));
      onClose();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      const stale = code === 'PLUGIN_ACCESS_CONFLICT';
      setConflict(stale);
      const message = t(
        stale
          ? 'plugins.accessConflict'
          : code === 'PLUGIN_ACCESS_USER_NOT_FOUND'
            ? 'plugins.accessUserMissing'
            : 'plugins.accessSaveFailed',
      );
      setError(message);
      toast.error(message);
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving.current) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={(event) => {
          if (saving.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {t('plugins.accessTitle', { name: plugin.name })}
          </DialogTitle>
          <DialogDescription>{t('plugins.accessHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-5">
          <ScrollArea
            className="min-h-0"
            viewportProps={{ className: 'max-h-[65dvh]' }}
          >
            <div className="space-y-4 p-1">
              {!configuration && !error ? (
                <LoadingState />
              ) : configuration ? (
                <fieldset disabled={pending} className="space-y-4">
                  <Select
                    value={configuration.access.mode}
                    onValueChange={(mode: 'all' | 'selected') =>
                      setConfiguration({
                        ...configuration,
                        access: { ...configuration.access, mode },
                      })
                    }
                    disabled={pending}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('plugins.accessScope')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        {t('plugins.accessAll')}
                      </SelectItem>
                      <SelectItem value="selected">
                        {t('plugins.accessSelected')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {configuration.access.mode === 'selected' && (
                    <>
                      <AdminUserSelect
                        value={configuration.access.userIds}
                        disabled={pending}
                        onChange={(userIds) =>
                          setConfiguration({
                            ...configuration,
                            access: { ...configuration.access, userIds },
                          })
                        }
                      />
                      {!configuration.access.userIds.length && (
                        <p className="text-sm text-muted-foreground">
                          {t('plugins.accessAdminOnly')}
                        </p>
                      )}
                    </>
                  )}
                </fieldset>
              ) : null}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {(conflict || (!configuration && error)) && (
                <Button type="button" variant="outline" onClick={reload}>
                  {t('plugins.configReload')}
                </Button>
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('plugins.configCancel')}
            </Button>
            <Button
              type="submit"
              disabled={!configuration || pending || conflict}
            >
              {pending && <Loader2 className="animate-spin" />}
              {t('plugins.accessSave')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
