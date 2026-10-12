import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ManagedAgent } from '@aime/shared/agents';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { agentErrorKey } from '../api';

export function DeleteAgentDialog({
  agent,
  onClose,
  onRemoved,
  restoreFocus,
}: {
  agent: ManagedAgent;
  onClose: () => void;
  onRemoved: (id: string) => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  const submitting = useRef(false);
  async function remove() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      await api.agents.remove({
        params: { id: agent.id },
        query: { versionId: agent.versionId },
      });
      onRemoved(agent.id);
      toast.success(t('agents.deleted'));
      onClose();
    } catch (cause) {
      const key = agentErrorKey(cause);
      setError(key);
      toast.error(t(key));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={(event) => {
          if (submitting.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('agents.delete')}</DialogTitle>
          <DialogDescription className="break-words">
            {t('agents.deleteHint', { name: agent.name })}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {t(error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {t('agents.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void remove()}
          >
            {t(pending ? 'agents.saving' : 'agents.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
