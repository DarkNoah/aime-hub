import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  webSearchConfigSchema,
  webFetchConfigSchema,
  type ToolConfig,
} from '@aime/shared/tools';
import type { ProviderSummary } from '@aime/shared/providers';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
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
import { toolErrorKey } from '../api';
import { toolDefinitions } from '../definitions';

export function WebToolDialog({
  tool,
  providers,
  onSaved,
  onClose,
  restoreFocus,
}: {
  tool: Exclude<ToolConfig, { id: 'image_gen' }>;
  providers: ProviderSummary[];
  onSaved: (tool: ToolConfig) => void;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const definition = toolDefinitions[tool.id];
  const isSearch = tool.id === 'web_search';
  const [enabled, setEnabled] = useState(tool.config.enabled);
  const [providerId, setProviderId] = useState(
    tool.config.providerId ?? definition.localId,
  );
  const [limit, setLimit] = useState(
    String(
      tool.id === 'web_search' ? tool.config.numResults : tool.config.maxChars,
    ),
  );
  const [timeout, setTimeout] = useState(String(tool.config.timeoutMs / 1000));
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<
    Partial<
      Record<'limit' | 'timeoutMs' | 'providerId' | 'form', TranslationKey>
    >
  >({});
  const submitting = useRef(false);
  const choices = providers.filter(
    (provider) => provider.type === definition.providerType,
  );
  const missing =
    providerId !== definition.localId &&
    !choices.some((provider) => provider.id === providerId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const parsed = (
      isSearch ? webSearchConfigSchema : webFetchConfigSchema
    ).safeParse({
      enabled,
      providerId: providerId === definition.localId ? null : providerId,
      ...(isSearch
        ? { numResults: Number(limit) }
        : { maxChars: Number(limit) }),
      timeoutMs: Number(timeout) * 1000,
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'numResults') next.limit = 'tools.numResultsHint';
        if (issue.path[0] === 'maxChars') next.limit = 'tools.maxCharsHint';
        if (issue.path[0] === 'timeoutMs') next.timeoutMs = 'tools.timeoutHint';
      }
      setErrors(next);
      return;
    }
    if (
      enabled &&
      providerId !== definition.localId &&
      !choices.some(
        (provider) =>
          provider.id === providerId && provider.enabled && provider.hasApiKey,
      )
    ) {
      setErrors({ providerId: definition.invalidProvider });
      return;
    }
    submitting.current = true;
    setPending(true);
    setErrors({});
    try {
      const saved = await api.tools.update(
        isSearch
          ? {
              params: { toolId: 'web_search' },
              body: webSearchConfigSchema.parse(parsed.data),
            }
          : {
              params: { toolId: 'web_fetch' },
              body: webFetchConfigSchema.parse(parsed.data),
            },
      );
      onSaved(saved);
      toast.success(t('tools.saved'));
      onClose();
    } catch (error) {
      const key = toolErrorKey(error, tool.id);
      setErrors({ form: key });
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
        className="flex max-h-[90dvh] flex-col sm:max-w-lg"
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
          <DialogTitle>{t(definition.configure)}</DialogTitle>
          <DialogDescription>{t('tools.applyHint')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={submit}
          noValidate
          className="flex min-h-0 flex-col gap-5"
        >
          <ScrollArea
            className="min-h-0"
            viewportProps={{ className: 'max-h-[60dvh]' }}
          >
            <fieldset disabled={pending} className="space-y-5 p-1">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="search-enabled">{t(definition.enable)}</Label>
                <Switch
                  id="search-enabled"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={pending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="search-provider">
                  {t(definition.provider)}
                </Label>
                <Select
                  value={providerId}
                  onValueChange={setProviderId}
                  disabled={pending}
                >
                  <SelectTrigger
                    id="search-provider"
                    className="w-full"
                    aria-invalid={!!errors.providerId}
                    aria-describedby="search-provider-hint"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={definition.localId}>
                      {t(definition.localLabel)}
                    </SelectItem>
                    {missing ? (
                      <SelectItem value={providerId} disabled>
                        {t(definition.missingProvider)}
                      </SelectItem>
                    ) : null}
                    {choices.map((provider) => (
                      <SelectItem
                        key={provider.id}
                        value={provider.id}
                        disabled={!provider.enabled || !provider.hasApiKey}
                      >
                        {provider.name}
                        {!provider.enabled || !provider.hasApiKey
                          ? ` · ${t('tools.unavailable')}`
                          : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p
                  id="search-provider-hint"
                  className={
                    errors.providerId
                      ? 'text-xs text-destructive'
                      : 'text-xs leading-5 text-muted-foreground'
                  }
                >
                  {t(errors.providerId ?? definition.providerHint)}
                </p>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="search-count">
                    {t(isSearch ? 'tools.numResults' : 'tools.maxChars')}
                  </Label>
                  <Input
                    id="search-count"
                    type="number"
                    min={isSearch ? 1 : 1000}
                    max={isSearch ? 20 : 200000}
                    step={1}
                    value={limit}
                    onChange={(event) => setLimit(event.target.value)}
                    aria-invalid={!!errors.limit}
                    aria-describedby="search-count-hint"
                  />
                  <p
                    id="search-count-hint"
                    className={
                      errors.limit
                        ? 'text-xs text-destructive'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {t(
                      isSearch ? 'tools.numResultsHint' : 'tools.maxCharsHint',
                    )}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="search-timeout">{t('tools.timeout')}</Label>
                  <Input
                    id="search-timeout"
                    type="number"
                    min={1}
                    max={60}
                    step={1}
                    value={timeout}
                    onChange={(event) => setTimeout(event.target.value)}
                    aria-invalid={!!errors.timeoutMs}
                    aria-describedby="search-timeout-hint"
                  />
                  <p
                    id="search-timeout-hint"
                    className={
                      errors.timeoutMs
                        ? 'text-xs text-destructive'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {t(
                      isSearch ? 'tools.timeoutHint' : 'tools.fetchTimeoutHint',
                    )}
                  </p>
                </div>
              </div>
              <p className="rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
                {t(definition.fallbackHint)}
              </p>
              {errors.form ? (
                <p role="alert" className="text-sm text-destructive">
                  {t(errors.form)}
                </p>
              ) : null}
            </fieldset>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('tools.cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              {t(pending ? 'tools.saving' : 'tools.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
