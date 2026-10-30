import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type {
  GroupChatAgent,
  GroupChatAgentInput,
} from '@aime/shared/group-chats';
import { reasoningEfforts, type ReasoningEffort } from '@aime/shared/threads';
import { AgentSelector } from '@/components/agent-selector';
import { ModelSelector } from '@/components/model-selector';
import { useAvailableAgents } from '@/features/agents/use-available-agents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { groupChatApi, groupChatErrorKey } from '../api';

export function RoomAgentEditor({
  roomId,
  projectId,
  agent,
  onSaved,
  onClose,
}: {
  roomId: string;
  projectId?: string;
  agent: GroupChatAgent;
  onSaved: (agent: GroupChatAgent) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const isBot = agent.role === 'bot';
  const catalog = useAvailableAgents(projectId, true);
  const [pending, setPending] = useState(false);
  const [idleWakeEnabled, setIdleWakeEnabled] = useState(
    agent.idleWakeHours != null,
  );
  const [idleWakeHours, setIdleWakeHours] = useState(
    String(agent.idleWakeHours ?? 1),
  );
  const validIdleHours =
    !isBot ||
    !idleWakeEnabled ||
    (Number.isFinite(Number(idleWakeHours)) &&
      Number(idleWakeHours) > 0 &&
      Number(idleWakeHours) <= 8760);
  const [form, setForm] = useState<GroupChatAgentInput>(() => ({
    name: agent.name,
    settings: agent.settings,
    enabled: agent.enabled,
  }));
  const selected = catalog.data?.agents.find(
    (item) =>
      item.id === (form.settings.agentId ?? catalog.data?.defaultAgentId),
  );
  const fixedModel = isBot ? undefined : selected?.model;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !form.name.trim() || !validIdleHours) return;
    setPending(true);
    try {
      const saved = await groupChatApi.updateAgent(
        roomId,
        agent.id,
        isBot
          ? {
              idleWakeHours: idleWakeEnabled ? Number(idleWakeHours) : null,
              settings: {
                ...form.settings,
                agentId: agent.settings.agentId,
              },
            }
          : form,
      );
      onSaved(saved);
      toast.success(t('groupChat.agentSaved'));
      onClose();
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
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
      <DialogContent className="max-h-[90dvh] overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{t('groupChat.editAgent')}</DialogTitle>
          <DialogDescription>
            {t(isBot ? 'groupChat.botSettingsHint' : 'groupChat.workerHint')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void save(event)} className="min-h-0">
          <ScrollArea viewportProps={{ className: 'max-h-[60dvh]' }}>
            <div className="space-y-5 px-6 py-4">
              {!isBot && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-name`}>
                      {t('groupChat.agentName')}
                    </Label>
                    <Input
                      id={`${id}-name`}
                      value={form.name}
                      maxLength={80}
                      disabled={pending}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-agent`}>{t('chat.agent')}</Label>
                    <AgentSelector
                      id={`${id}-agent`}
                      label={t('chat.agent')}
                      value={form.settings.agentId ?? null}
                      agents={catalog.data?.agents ?? []}
                      defaultAgentId={catalog.data?.defaultAgentId}
                      disabled={pending || catalog.loading}
                      onOpen={catalog.refresh}
                      onValueChange={(agentId) =>
                        setForm((current) => ({
                          ...current,
                          settings: { ...current.settings, agentId },
                        }))
                      }
                    />
                    {catalog.error && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={catalog.retry}
                      >
                        {t('agents.retry')}
                      </Button>
                    )}
                  </div>
                </>
              )}
              <div className="space-y-2">
                <Label htmlFor={`${id}-model`}>{t('chat.model')}</Label>
                <ModelSelector
                  id={`${id}-model`}
                  label={t('chat.model')}
                  value={fixedModel ?? form.settings.model}
                  textOnly
                  disabled={pending || !!fixedModel}
                  noneLabel={t('groupChat.defaultModel')}
                  onValueChange={(model) =>
                    setForm((current) => ({
                      ...current,
                      settings: { ...current.settings, model },
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-reasoning`}>
                  {t('chat.reasoningLevel')}
                </Label>
                <Select
                  value={form.settings.reasoningEffort}
                  disabled={pending}
                  onValueChange={(reasoningEffort) =>
                    setForm((current) => ({
                      ...current,
                      settings: {
                        ...current.settings,
                        reasoningEffort: reasoningEffort as ReasoningEffort,
                      },
                    }))
                  }
                >
                  <SelectTrigger id={`${id}-reasoning`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {reasoningEfforts.map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        {effort === 'auto'
                          ? t('groupChat.automatic')
                          : t(`chat.reasoning.${effort}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!isBot && (
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor={`${id}-enabled`}>
                    {t('groupChat.agentEnabled')}
                  </Label>
                  <Switch
                    id={`${id}-enabled`}
                    checked={form.enabled}
                    disabled={pending}
                    onCheckedChange={(enabled) =>
                      setForm((current) => ({ ...current, enabled }))
                    }
                  />
                </div>
              )}
              {isBot && (
                <section className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between gap-4">
                    <Label htmlFor={`${id}-idle-wake`}>
                      {t('groupChat.idleWake')}
                    </Label>
                    <Switch
                      id={`${id}-idle-wake`}
                      checked={idleWakeEnabled}
                      disabled={pending}
                      onCheckedChange={setIdleWakeEnabled}
                    />
                  </div>
                  {idleWakeEnabled && (
                    <div className="space-y-2">
                      <Label htmlFor={`${id}-idle-hours`}>
                        {t('groupChat.idleWakeHours')}
                      </Label>
                      <Input
                        id={`${id}-idle-hours`}
                        type="number"
                        step="any"
                        min="0"
                        max="8760"
                        value={idleWakeHours}
                        disabled={pending}
                        aria-invalid={!validIdleHours}
                        aria-describedby={`${id}-idle-hint`}
                        onChange={(event) =>
                          setIdleWakeHours(event.target.value)
                        }
                      />
                      {!validIdleHours && (
                        <p role="alert" className="text-xs text-destructive">
                          {t('groupChat.idleWakeInvalid')}
                        </p>
                      )}
                    </div>
                  )}
                  <p
                    id={`${id}-idle-hint`}
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    {t('groupChat.idleWakeHint')}
                  </p>
                </section>
              )}
            </div>
          </ScrollArea>
          <DialogFooter className="border-t px-6 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('agents.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={pending || !form.name.trim() || !validIdleHours}
            >
              {t(pending ? 'agents.saving' : 'agents.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
