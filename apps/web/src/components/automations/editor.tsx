import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  automationInputSchema,
  automationStepLimits,
  type Automation,
  type AutomationInput,
  type AutomationScope,
} from '@aime/shared/automations';
import { api } from '@/lib/rpc';
import { AgentSelector } from '@/components/agent-selector';
import { ModelSelector } from '@/components/model-selector';
import { useAvailableAgents } from '@/features/agents/use-available-agents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { automationErrorKey } from './errors';
import { DesktopNotificationSwitch } from './desktop-notification-switch';

const cadences = [
  '0 9 * * *',
  '0 9 * * 1-5',
  '0 9 * * 1',
  '0 * * * *',
] as const;
export function AutomationEditor({
  scope,
  task,
  onClose,
  onSaved,
  restoreFocus,
}: {
  scope: AutomationScope;
  task?: Automation;
  onClose: () => void;
  onSaved: (task: Automation) => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const agents = useAvailableAgents();
  const [form, setForm] = useState<AutomationInput>(() =>
    task
      ? {
          name: task.name,
          prompt: task.prompt,
          cron: task.cron,
          maxSteps: task.maxSteps,
          separateThread: task.separateThread,
          desktopNotification: task.desktopNotification,
          settings: task.settings,
          enabled: task.enabled,
        }
      : {
          name: '',
          prompt: '',
          cron: cadences[0],
          maxSteps: null,
          separateThread: false,
          desktopNotification: false,
          settings: { agentId: null, model: null, reasoningEffort: 'auto' },
          enabled: true,
        },
  );
  const [cadence, setCadence] = useState(() =>
    cadences.includes(form.cron as (typeof cadences)[number])
      ? form.cron
      : 'custom',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const selectedAgent = agents.data?.agents.find(
    (agent) =>
      agent.id === (form.settings.agentId ?? agents.data?.defaultAgentId),
  );
  const change = <K extends keyof AutomationInput>(
    key: K,
    value: AutomationInput[K],
  ) => setForm((current) => ({ ...current, [key]: value }));
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const parsed = automationInputSchema.safeParse(form);
    if (!parsed.success) {
      setInvalid(parsed.error.issues.map((issue) => String(issue.path[0])));
      setError(t('automations.required'));
      return;
    }
    setPending(true);
    setError('');
    setInvalid([]);
    try {
      const saved = task
        ? await api.automations.update({ id: task.id, data: parsed.data })
        : await api.automations.create({ scope, data: parsed.data });
      onSaved(saved);
      toast.success(t('automations.saved'));
      onClose();
    } catch (cause) {
      const key = automationErrorKey(cause);
      setError(t(key));
      setInvalid(key === 'automations.invalidCron' ? ['cron'] : []);
      toast.error(t(key));
    } finally {
      setPending(false);
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <SheetContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        className="w-full gap-0 sm:max-w-xl"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <div className="space-y-2 border-b px-6 py-5 pr-14">
          <SheetTitle>
            {t(task ? 'automations.edit' : 'automations.create')}
          </SheetTitle>
          <SheetDescription>{t('automations.editorHint')}</SheetDescription>
        </div>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => void save(event)}
          noValidate
        >
          <ScrollArea className="min-h-0 flex-1">
            <fieldset disabled={pending} className="space-y-6 p-6">
              <div className="space-y-2">
                <Label htmlFor={`${id}-name`}>{t('automations.name')}</Label>
                <Input
                  id={`${id}-name`}
                  value={form.name}
                  maxLength={120}
                  onChange={(event) => change('name', event.target.value)}
                  placeholder={t('automations.namePlaceholder')}
                  aria-invalid={invalid.includes('name')}
                  aria-describedby={error ? `${id}-error` : undefined}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-prompt`}>
                  {t('automations.prompt')}
                </Label>
                <Textarea
                  id={`${id}-prompt`}
                  className="min-h-36 resize-y"
                  value={form.prompt}
                  maxLength={20000}
                  onChange={(event) => change('prompt', event.target.value)}
                  placeholder={t('automations.promptPlaceholder')}
                  aria-invalid={invalid.includes('prompt')}
                  aria-describedby={error ? `${id}-error` : undefined}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-cadence`}>
                  {t('automations.cadence')}
                </Label>
                <Select
                  value={cadence}
                  onValueChange={(value) => {
                    setCadence(value);
                    if (value !== 'custom') change('cron', value);
                  }}
                  disabled={pending}
                >
                  <SelectTrigger id={`${id}-cadence`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {cadences.map((value, index) => (
                      <SelectItem key={value} value={value}>
                        {t(
                          (
                            [
                              'automations.daily',
                              'automations.weekdays',
                              'automations.weekly',
                              'automations.hourly',
                            ] as const
                          )[index],
                        )}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">
                      {t('automations.custom')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(cadence === 'custom' || invalid.includes('cron')) && (
                <div className="space-y-2">
                  <Label htmlFor={`${id}-cron`}>{t('automations.cron')}</Label>
                  <Input
                    id={`${id}-cron`}
                    value={form.cron}
                    onChange={(event) => change('cron', event.target.value)}
                    className="font-mono"
                    aria-invalid={invalid.includes('cron')}
                    aria-describedby={`${id}-cron-hint`}
                  />
                  <p
                    id={`${id}-cron-hint`}
                    className="text-xs text-muted-foreground"
                  >
                    {t('automations.cronHint')}
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t('automations.systemTimezone')}
              </p>
              <div className="space-y-2">
                <Label htmlFor={`${id}-agent`}>{t('automations.agent')}</Label>
                <AgentSelector
                  id={`${id}-agent`}
                  label={t('automations.agent')}
                  value={form.settings.agentId ?? null}
                  onValueChange={(agentId) =>
                    change('settings', { ...form.settings, agentId })
                  }
                  agents={agents.data?.agents ?? []}
                  defaultAgentId={agents.data?.defaultAgentId}
                  disabled={pending || agents.loading || agents.error}
                />
                {agents.error && (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-2 text-sm text-destructive"
                  >
                    <span>{t('automations.agentLoadFailed')}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={agents.retry}
                    >
                      {t('providers.retry')}
                    </Button>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-model`}>{t('automations.model')}</Label>
                <ModelSelector
                  id={`${id}-model`}
                  label={t('automations.model')}
                  value={selectedAgent?.model ?? form.settings.model}
                  onValueChange={(model) =>
                    change('settings', { ...form.settings, model })
                  }
                  disabled={pending || !!selectedAgent?.model}
                  textOnly
                  noneLabel={t('automations.defaultModel')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('automations.modelHint')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-max-steps`}>
                  {t('automations.maxSteps')}
                </Label>
                <Select
                  value={String(form.maxSteps ?? 'unlimited')}
                  onValueChange={(value) =>
                    change(
                      'maxSteps',
                      automationInputSchema.shape.maxSteps.parse(
                        value === 'unlimited' ? null : Number(value),
                      ),
                    )
                  }
                  disabled={pending}
                >
                  <SelectTrigger
                    id={`${id}-max-steps`}
                    className="w-full"
                    aria-describedby={`${id}-max-steps-hint`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unlimited">
                      {t('automations.unlimitedSteps')}
                    </SelectItem>
                    {automationStepLimits.map((limit) => (
                      <SelectItem key={limit} value={String(limit)}>
                        {limit}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p
                  id={`${id}-max-steps-hint`}
                  className="text-xs text-muted-foreground"
                >
                  {t('automations.maxStepsHint')}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 border-t pt-5">
                <div className="space-y-1">
                  <Label htmlFor={`${id}-separate-thread`}>
                    {t('automations.separateThread')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('automations.separateThreadHint')}
                  </p>
                </div>
                <Switch
                  id={`${id}-separate-thread`}
                  checked={form.separateThread}
                  onCheckedChange={(value) => change('separateThread', value)}
                  disabled={pending}
                />
              </div>
              <DesktopNotificationSwitch
                checked={form.desktopNotification}
                onCheckedChange={(value) =>
                  change('desktopNotification', value)
                }
                disabled={pending}
              />
              <div className="flex items-center justify-between gap-4 border-t pt-5">
                <Label htmlFor={`${id}-enabled`}>
                  {t('automations.enable')}
                </Label>
                <Switch
                  id={`${id}-enabled`}
                  checked={form.enabled}
                  onCheckedChange={(enabled) => change('enabled', enabled)}
                  disabled={pending}
                />
              </div>
              {error && (
                <p
                  role="alert"
                  id={`${id}-error`}
                  className="text-sm text-destructive"
                >
                  {error}
                </p>
              )}
            </fieldset>
          </ScrollArea>
          <div className="flex justify-end gap-3 border-t p-5">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={pending}
            >
              {t('providers.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={pending || agents.loading || agents.error}
            >
              {t(pending ? 'automations.saving' : 'providers.save')}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
