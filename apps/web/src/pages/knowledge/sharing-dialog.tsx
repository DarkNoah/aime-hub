import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  knowledgeLocked,
  type KnowledgeBase,
  type KnowledgeSharingDetail,
  type KnowledgeSharing,
} from '@aime/shared/knowledge';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { knowledgeError } from './errors';
import { PermissionSelect } from './permission-select';
import { SharingMembers } from './sharing-members';

export function SharingDialog({
  base,
  onClose,
  onSaved,
}: {
  base: KnowledgeBase;
  onClose: () => void;
  onSaved: (base: KnowledgeBase) => void;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<KnowledgeSharingDetail>();
  const [error, setError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const locked = knowledgeLocked(base) || !base.canShare;
  useEffect(() => {
    const c = new AbortController();
    void api.knowledge
      .sharing({ id: base.id }, { signal: c.signal })
      .then((v) => {
        setSettings(v);
        setError(undefined);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [base.id, retry]);
  async function save(sharing: KnowledgeSharing) {
    if (!settings || locked || busy) return;
    setBusy(true);
    try {
      const updated = await api.knowledge.setSharing({ id: base.id, sharing });
      setSettings({
        mode: sharing.mode,
        permission: sharing.mode === 'all' ? sharing.permission : 'read',
        memberCount: sharing.mode === 'members' ? settings.memberCount : 0,
      });
      onSaved(updated);
      toast.success(t('knowledge.saved'));
    } catch (e) {
      toast.error(t(knowledgeError(e)));
    } finally {
      setBusy(false);
    }
  }
  const disabled = locked || busy;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <ScrollArea viewportProps={{ className: 'max-h-[90dvh]' }}>
          <div className="space-y-5 p-6">
            <DialogHeader>
              <DialogTitle>{t('knowledge.sharing')}</DialogTitle>
              <DialogDescription>
                {t('knowledge.sharingHint')} {t('knowledge.sharingAutoSave')}
              </DialogDescription>
            </DialogHeader>
            {error ? (
              <div role="alert" className="space-y-3">
                <p>{t(knowledgeError(error))}</p>
                <Button
                  variant="outline"
                  onClick={() => setRetry((n) => n + 1)}
                >
                  {t('knowledge.retry')}
                </Button>
              </div>
            ) : !settings ? (
              <p role="status">{t('knowledge.loading')}</p>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>{t('knowledge.shareScope')}</Label>
                  <Select
                    value={settings.mode}
                    disabled={disabled}
                    onValueChange={(mode: KnowledgeSharingDetail['mode']) =>
                      void save(
                        mode === 'all'
                          ? { mode, permission: 'read' }
                          : { mode },
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={t('knowledge.shareScope')}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['private', 'all', 'members'] as const).map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {t(`knowledge.sharing.${mode}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {settings.mode === 'all' && (
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <Label>{t('knowledge.allPermission')}</Label>
                    <PermissionSelect
                      value={settings.permission}
                      disabled={disabled}
                      onChange={(permission) =>
                        void save({ mode: 'all', permission })
                      }
                      label={t('knowledge.allPermission')}
                    />
                  </div>
                )}
                {settings.mode === 'members' && (
                  <SharingMembers
                    id={base.id}
                    disabled={disabled}
                    onBusyChange={setBusy}
                  />
                )}
                <p className="rounded-lg bg-muted p-3 text-sm leading-6">
                  {t('knowledge.permissionHint')}
                </p>
                {locked && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {t('knowledge.rebuildLockHint')}
                  </p>
                )}
              </>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                {t('common.close')}
              </Button>
            </DialogFooter>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
