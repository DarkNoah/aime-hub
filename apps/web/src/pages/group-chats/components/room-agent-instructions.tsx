import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { LocalAgentScope } from '@aime/shared/agents';
import { localAgentErrorKey } from '@/components/local-agents/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';

type AgentFile = { target: LocalAgentScope; filename: string };

export function RoomAgentInstructions({ file }: { file: AgentFile }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!saving) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t('groupChat.editInstructions')}
        </Button>
      </DialogTrigger>
      {open && (
        <InstructionsDialog
          file={file}
          saving={saving}
          setSaving={setSaving}
          close={() => setOpen(false)}
        />
      )}
    </Dialog>
  );
}

function InstructionsDialog({
  file,
  saving,
  setSaving,
  close,
}: {
  file: AgentFile;
  saving: boolean;
  setSaving: (value: boolean) => void;
  close: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [source, setSource] =
    useState<Awaited<ReturnType<typeof api.localAgents.getInstructions>>>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<TranslationKey>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api.localAgents
      .getInstructions({ query: file }, { signal: controller.signal })
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          setSource(result);
          setDraft(result.instructions);
        },
        (cause) => {
          if (!controller.signal.aborted) setError(localAgentErrorKey(cause));
        },
      );
    return () => controller.abort();
  }, [file, attempt]);

  async function save() {
    if (!source?.canManage || saving || !draft.trim()) return;
    setSaving(true);
    try {
      await api.localAgents.updateInstructions({
        body: { ...file, instructions: draft, version: source.version },
      });
      toast.success(t('localAgents.updated', { filename: file.filename }));
      close();
    } catch (cause) {
      toast.error(t(localAgentErrorKey(cause)));
    } finally {
      setSaving(false);
    }
  }
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('groupChat.editInstructions')}</DialogTitle>
        <DialogDescription>
          {t('groupChat.instructionsHint', { filename: file.filename })}
        </DialogDescription>
      </DialogHeader>
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 text-sm"
        >
          {t(error)}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setError(undefined);
              setAttempt((value) => value + 1);
            }}
          >
            {t('agents.retry')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={id}>{t('groupChat.agentInstructions')}</Label>
          <Textarea
            id={id}
            rows={8}
            className="field-sizing-fixed max-h-[45dvh] resize-y"
            disabled={!source || saving}
            readOnly={!source?.canManage}
            value={draft}
            placeholder={!source ? t('chat.loading') : undefined}
            onChange={(event) => setDraft(event.target.value)}
          />
          {source && !source.canManage && (
            <p className="text-sm text-muted-foreground">
              {t('localAgents.readOnlyHint')}
            </p>
          )}
        </div>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={close}
        >
          {t('agents.cancel')}
        </Button>
        {source?.canManage && (
          <Button
            type="button"
            disabled={saving || !draft.trim() || draft === source.instructions}
            onClick={() => void save()}
          >
            {t(saving ? 'agents.saving' : 'agents.save')}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
