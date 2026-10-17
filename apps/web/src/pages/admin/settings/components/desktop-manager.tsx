import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SystemSettings } from '@aime/shared/system-settings';
import { desktopTimeoutSchema } from '@aime/shared/system-settings';
import type { DesktopSandbox } from '@aime/shared/e2b-desktop';
import { api } from '@/lib/rpc';
import { Badge } from '@/components/ui/badge';
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
import { ScrollArea } from '@/components/ui/scroll-area';

import { desktopErrorKey } from './desktop-errors';

export function DesktopManager({
  settings,
  onClose,
}: {
  settings: SystemSettings;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<DesktopSandbox[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof desktopErrorKey>>();
  const [editing, setEditing] = useState<DesktopSandbox | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DesktopSandbox | null>(null);
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);

  async function load(token?: string) {
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.systemSettings.desktop.list({
        query: token ? { nextToken: token } : {},
      });
      setError(undefined);
      setItems((current) =>
        token
          ? [
              ...new Map(
                [...current, ...result.items].map((item) => [item.id, item]),
              ).values(),
            ]
          : result.items,
      );
      setNextToken(result.nextToken);
    } catch (cause) {
      setError(desktopErrorKey(cause));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void api.systemSettings.desktop
      .list({ query: {} }, { signal: controller.signal })
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          setItems(result.items);
          setNextToken(result.nextToken);
          setLoading(false);
        },
        (cause) => {
          if (controller.signal.aborted) return;
          setError(desktopErrorKey(cause));
          setLoading(false);
        },
      );
    return () => controller.abort();
  }, []);

  async function save(value: {
    name: string;
    template: string;
    timeoutSeconds: number;
  }) {
    if (changing.current || !editing) return;
    changing.current = true;
    setBusy(true);
    try {
      let id: string;
      if (editing === 'new') {
        ({ id } = await api.systemSettings.desktop.create({ body: value }));
        toast.success(t('settings.desktopCreated', { id }));
      } else {
        id = editing.id;
        await api.systemSettings.desktop.update({
          params: { id },
          body: { timeoutSeconds: value.timeoutSeconds },
        });
        toast.success(t('settings.desktopUpdated'));
      }
      setEditing(null);
      // Update only the affected row; preserve pagination and scroll position.
      try {
        const updated = await api.systemSettings.desktop.get({
          params: { id },
        });
        setItems((current) =>
          current.some((item) => item.id === id)
            ? current.map((item) => (item.id === id ? updated : item))
            : [updated, ...current],
        );
      } catch {
        toast.warning(t('settings.desktopRefreshNeeded', { id }));
      }
    } catch (cause) {
      toast.error(t(desktopErrorKey(cause)));
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting || changing.current) return;
    changing.current = true;
    setBusy(true);
    try {
      await api.systemSettings.desktop.delete({ params: { id: deleting.id } });
      setItems((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(null);
      toast.success(t('settings.desktopDeleted'));
    } catch (cause) {
      toast.error(t(desktopErrorKey(cause)));
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }

  function date(value: string) {
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.valueOf())
      ? '—'
      : timestamp.toLocaleString(i18n.language);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('settings.desktopManage')}</DialogTitle>
          <DialogDescription>
            {t('settings.desktopManageHint')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            <RefreshCw />
            {t('settings.desktopRefresh')}
          </Button>
          <Button disabled={busy || loading} onClick={() => setEditing('new')}>
            <Plus />
            {t('settings.desktopCreate')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {t(error)}
          </p>
        )}
        <ScrollArea
          className="max-h-[55dvh]"
          viewportProps={{ className: 'max-h-[55dvh]' }}
        >
          <table className="w-full text-left text-sm [&_th]:px-3 [&_th]:py-3 [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:px-3 [&_td]:py-3 [&_tr]:border-b">
            <thead>
              <tr>
                <th>{t('settings.desktopInstance')}</th>
                <th>{t('settings.desktopTemplate')}</th>
                <th>{t('settings.desktopState')}</th>
                <th>{t('settings.desktopExpires')}</th>
                <th className="text-right">{t('settings.desktopActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="font-medium">{item.name || item.id}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.id}
                    </div>
                  </td>
                  <td>{item.template}</td>
                  <td>
                    <Badge
                      variant={
                        item.state === 'running' ? 'secondary' : 'outline'
                      }
                    >
                      {t(
                        item.state === 'running'
                          ? 'settings.desktopRunning'
                          : 'settings.desktopPaused',
                      )}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap text-xs">
                    {date(item.endAt)}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy || loading || item.state !== 'running'}
                        aria-label={t('settings.desktopEditLabel', {
                          name: item.name || item.id,
                        })}
                        onClick={() => setEditing(item)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy || loading}
                        aria-label={t('settings.desktopDeleteLabel', {
                          name: item.name || item.id,
                        })}
                        onClick={() => setDeleting(item)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td
                    colSpan={5}
                    className="h-24 text-center text-muted-foreground"
                  >
                    {loading
                      ? t('settings.desktopLoading')
                      : error
                        ? t('settings.desktopLoadFailed')
                        : t('settings.desktopEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollArea>
        {nextToken && (
          <Button
            variant="outline"
            disabled={loading || busy}
            onClick={() => void load(nextToken)}
          >
            {loading && <Loader2 className="animate-spin" />}
            {t('settings.desktopLoadMore')}
          </Button>
        )}
        {editing && (
          <SandboxDialog
            settings={settings}
            sandbox={editing}
            busy={busy}
            onSave={save}
            onClose={() => setEditing(null)}
          />
        )}
        <Dialog
          open={Boolean(deleting)}
          onOpenChange={(open) => {
            if (!open && !busy) setDeleting(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t('settings.desktopDeleteLabel', {
                  name: deleting?.name || deleting?.id || '',
                })}
              </DialogTitle>
              <DialogDescription>
                {t('settings.desktopDeleteHint')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                {t('settings.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void remove();
                }}
              >
                {busy && <Loader2 className="animate-spin" />}
                {t('settings.desktopDelete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

function SandboxDialog({
  settings,
  sandbox,
  busy,
  onSave,
  onClose,
}: {
  settings: SystemSettings;
  sandbox: DesktopSandbox | 'new';
  busy: boolean;
  onSave: (value: {
    name: string;
    template: string;
    timeoutSeconds: number;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const creating = sandbox === 'new';
  const [name, setName] = useState(creating ? '' : sandbox.name);
  const [template, setTemplate] = useState(
    creating ? settings.e2bDesktopTemplate : sandbox.template,
  );
  const [timeout, setTimeout] = useState(
    String(settings.e2bDesktopTimeoutSeconds),
  );
  const [invalid, setInvalid] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = Number(timeout);
    if (!desktopTimeoutSchema.safeParse(value).success || !template.trim()) {
      setInvalid(true);
      return;
    }
    void onSave({
      name: name.trim(),
      template: template.trim(),
      timeoutSeconds: value,
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(creating ? 'settings.desktopCreate' : 'settings.desktopEdit')}
          </DialogTitle>
          <DialogDescription>
            {t(
              creating
                ? 'settings.desktopCreateHint'
                : 'settings.desktopEditHint',
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
          <ScrollArea
            className="max-h-[55dvh]"
            viewportProps={{ className: 'max-h-[55dvh]' }}
          >
            <div className="space-y-4 p-1">
              {creating && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="sandbox-name">
                      {t('settings.desktopName')}
                    </Label>
                    <Input
                      id="sandbox-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sandbox-template">
                      {t('settings.desktopTemplate')}
                    </Label>
                    <Input
                      id="sandbox-template"
                      value={template}
                      onChange={(event) => setTemplate(event.target.value)}
                      disabled={busy}
                      required
                    />
                  </div>
                </>
              )}
              <div className="space-y-2">
                <Label htmlFor="sandbox-timeout">
                  {t('settings.desktopRemaining')}
                </Label>
                <Input
                  id="sandbox-timeout"
                  type="number"
                  value={timeout}
                  onChange={(event) => {
                    setTimeout(event.target.value);
                    setInvalid(false);
                  }}
                  disabled={busy}
                  required
                  aria-invalid={invalid}
                />
              </div>
              {invalid && (
                <p role="alert" className="text-sm text-destructive">
                  {t('settings.desktopInstanceInvalid')}
                </p>
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {t('settings.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {t(creating ? 'settings.desktopCreate' : 'settings.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
