import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import type { ProviderModel, ProviderSummary } from '@aime/shared/providers';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/password-input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  modelFormInput,
  modelPath,
  providerErrorKey,
  providerFormInput,
  providerPath,
  providerRequest,
  providersPath,
} from '@/pages/admin/providers/api';
import type { ErrorKey } from '@/i18n/config';
import { ProviderTypeSelector } from './provider-type-selector';

export type ProviderAction =
  | { kind: 'provider'; provider?: ProviderSummary }
  | { kind: 'model'; providerId: string; model?: ProviderModel }
  | { kind: 'deleteProvider'; provider: ProviderSummary }
  | { kind: 'deleteModel'; model: ProviderModel };

export function ProviderActionDialog({
  action,
  onClose,
  onSuccess,
  restoreFocus,
}: {
  action: ProviderAction;
  onClose: () => void;
  onSuccess: (provider?: ProviderSummary) => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const provider = action.kind === 'provider' ? action.provider : undefined;
  const [providerType, setProviderType] = useState(provider?.type ?? 'openai');
  const model = action.kind === 'model' ? action.model : undefined;
  const [limits, setLimits] = useState({
    limitContext: String(model?.limitContext ?? ''),
    limitOutput: String(model?.limitOutput ?? ''),
  });
  const deleting =
    action.kind === 'deleteProvider' || action.kind === 'deleteModel';
  const deleteName =
    action.kind === 'deleteProvider'
      ? action.provider.name
      : action.kind === 'deleteModel'
        ? action.model.id
        : '';
  const title =
    action.kind === 'provider'
      ? provider
        ? 'providers.edit'
        : 'providers.create'
      : action.kind === 'model'
        ? model
          ? 'models.edit'
          : 'models.create'
        : action.kind === 'deleteProvider'
          ? 'providers.delete'
          : 'models.delete';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || (deleting && confirmation !== deleteName)) return;
    const form = new FormData(event.currentTarget);
    setError(null);
    let body: unknown;
    try {
      if (action.kind === 'provider') body = providerFormInput(form);
      else if (action.kind === 'model') body = modelFormInput(form);
    } catch (cause) {
      setError(providerErrorKey(cause));
      return;
    }
    submitting.current = true;
    setPending(true);
    try {
      let savedProvider: ProviderSummary | undefined;
      if (action.kind === 'provider') {
        savedProvider = await providerRequest<ProviderSummary>(
          provider ? providerPath(provider.id) : providersPath,
          {
            method: provider ? 'PATCH' : 'POST',
            body: JSON.stringify(body),
          },
        );
      } else if (action.kind === 'model') {
        await providerRequest(modelPath(action.providerId, model?.id), {
          method: model ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        });
      } else if (action.kind === 'deleteProvider') {
        await providerRequest(providerPath(action.provider.id), {
          method: 'DELETE',
        });
      } else {
        await providerRequest(
          modelPath(action.model.providerId, action.model.id),
          { method: 'DELETE' },
        );
      }
      onSuccess(savedProvider);
    } catch (cause) {
      toast.error(t(providerErrorKey(cause)));
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
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
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
          <DialogTitle>{t(title)}</DialogTitle>
          <DialogDescription>
            {t(
              deleting
                ? 'providers.deleteHint'
                : action.kind === 'provider'
                  ? 'providers.formHint'
                  : 'models.formHint',
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <fieldset disabled={pending} className="min-w-0 space-y-4">
            {deleting ? (
              <>
                <p className="break-all rounded-lg bg-muted p-3 text-sm">
                  {deleteName}
                </p>
                <Label htmlFor="delete-confirm">
                  {t('providers.deleteConfirm')}
                </Label>
                <Input
                  id="delete-confirm"
                  required
                  autoComplete="off"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </>
            ) : action.kind === 'provider' ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="provider-name">{t('providers.name')}</Label>
                  <Input
                    id="provider-name"
                    name="name"
                    required
                    maxLength={100}
                    defaultValue={provider?.name ?? ''}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider-type">{t('providers.type')}</Label>
                  <ProviderTypeSelector
                    value={providerType}
                    onChange={setProviderType}
                    disabled={pending}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(
                      providerType === 'mineru'
                        ? 'providers.configOnlyHint'
                        : 'providers.typeHint',
                    )}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider-url">{t('providers.baseUrl')}</Label>
                  <Input
                    id="provider-url"
                    name="baseUrl"
                    type="url"
                    required
                    maxLength={2048}
                    defaultValue={provider?.baseUrl ?? ''}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(
                      providerType === 'mineru'
                        ? 'providers.otherUrlHint'
                        : 'providers.urlHint',
                    )}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider-key">{t('providers.apiKey')}</Label>
                  <PasswordInput
                    id="provider-key"
                    name="apiKey"
                    groupClassName="h-11 rounded-lg bg-card"
                    disabled={pending}
                    showLabel={t('providers.showApiKey')}
                    hideLabel={t('providers.hideApiKey')}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={4096}
                    aria-describedby="provider-key-hint"
                  />
                  <p
                    id="provider-key-hint"
                    className="text-xs text-muted-foreground"
                  >
                    {t(
                      provider ? 'providers.keyKeepHint' : 'providers.keyHint',
                    )}
                  </p>
                  {provider && (
                    <p className="text-xs text-muted-foreground">
                      {t(
                        provider.hasApiKey
                          ? 'providers.keySet'
                          : 'providers.keyUnset',
                      )}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-start gap-2">
                  <Label htmlFor="provider-enabled">
                    {t('providers.enabled')}
                  </Label>
                  <Switch
                    id="provider-enabled"
                    name="enabled"
                    defaultChecked={provider?.enabled ?? true}
                    disabled={pending}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="model-id">{t('models.id')}</Label>
                    <Input
                      id="model-id"
                      name="id"
                      required
                      maxLength={256}
                      defaultValue={model?.id ?? ''}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="model-name">{t('models.name')}</Label>
                    <Input
                      id="model-name"
                      name="name"
                      required
                      maxLength={256}
                      defaultValue={model?.name ?? ''}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="model-displayName">
                    {t('models.displayName')}
                  </Label>
                  <Input
                    id="model-displayName"
                    name="displayName"
                    maxLength={256}
                    defaultValue={model?.displayName ?? ''}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="model-description">
                    {t('models.description')}
                  </Label>
                  <Textarea
                    id="model-description"
                    name="description"
                    maxLength={10000}
                    defaultValue={model?.description ?? ''}
                  />
                </div>
                <div className="flex flex-col items-start gap-2">
                  <Label htmlFor="model-enabled">
                    {t('providers.enabled')}
                  </Label>
                  <Switch
                    id="model-enabled"
                    name="enabled"
                    defaultChecked={model?.enabled ?? true}
                    disabled={pending}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-5">
                  {(['reasoning', 'toolCall'] as const).map((key) => (
                    <div key={key} className="flex items-center gap-2">
                      <Checkbox
                        id={`model-${key}`}
                        name={key}
                        defaultChecked={model?.[key] ?? false}
                        disabled={pending}
                      />
                      <Label htmlFor={`model-${key}`}>
                        {t(`models.${key}`)}
                      </Label>
                    </div>
                  ))}
                </div>
                {(['modalitiesInput', 'modalitiesOutput'] as const).map(
                  (key) => (
                    <fieldset
                      key={key}
                      className="space-y-2 rounded-lg border p-3"
                    >
                      <legend className="px-1 text-sm font-medium">
                        {t(`models.${key}`)}
                      </legend>
                      <div className="flex flex-wrap gap-4">
                        {(
                          ['text', 'image', 'audio', 'video', 'pdf'] as const
                        ).map((value) => (
                          <div key={value} className="flex items-center gap-2">
                            <Checkbox
                              id={`model-${key}-${value}`}
                              name={key}
                              value={value}
                              defaultChecked={(
                                model?.[key] ?? ['text']
                              ).includes(value)}
                              disabled={pending}
                            />
                            <Label htmlFor={`model-${key}-${value}`}>
                              {t(`models.modality.${value}`)}
                            </Label>
                          </div>
                        ))}
                      </div>
                    </fieldset>
                  ),
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {(['limitContext', 'limitOutput'] as const).map((key) => {
                    const presets =
                      key === 'limitContext'
                        ? [32, 64, 128, 256, 512]
                        : [16, 32, 64, 128, 256, 512];
                    return (
                      <div key={key} className="min-w-0 space-y-2">
                        <Label htmlFor={`model-${key}`}>
                          {t(`models.${key}`)}
                        </Label>
                        <Input
                          id={`model-${key}`}
                          name={key}
                          type="number"
                          min={1}
                          max={2147483647}
                          step={1}
                          value={limits[key]}
                          onChange={(event) =>
                            setLimits((current) => ({
                              ...current,
                              [key]: event.target.value,
                            }))
                          }
                          placeholder={t('models.modelDefault')}
                          aria-describedby={`model-${key}-hint`}
                        />
                        <div
                          role="group"
                          aria-label={t('models.limitPreset', {
                            field: t(`models.${key}`),
                          })}
                          className="flex flex-wrap gap-1.5"
                        >
                          {[
                            ...presets.map((k) => ({
                              value: String(k * 1000),
                              label: `${k}k`,
                            })),
                            { value: '', label: t('models.modelDefault') },
                          ].map((preset) => (
                            <Badge
                              key={preset.value}
                              asChild
                              variant={
                                limits[key] === preset.value
                                  ? 'default'
                                  : 'secondary'
                              }
                              className="min-h-7 px-2.5 py-1 hover:opacity-80"
                            >
                              <button
                                type="button"
                                aria-pressed={limits[key] === preset.value}
                                onClick={() =>
                                  setLimits((current) => ({
                                    ...current,
                                    [key]: preset.value,
                                  }))
                                }
                              >
                                {preset.label}
                              </button>
                            </Badge>
                          ))}
                        </div>
                        <p
                          id={`model-${key}-hint`}
                          className="text-xs text-muted-foreground"
                        >
                          {t('models.limitHint')}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={onClose}>
              {t('providers.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={pending || (deleting && confirmation !== deleteName)}
              className={
                deleting
                  ? 'bg-destructive text-white hover:bg-destructive/90'
                  : undefined
              }
            >
              {pending && <Loader2 className="animate-spin" />}
              {t(
                pending
                  ? 'providers.saving'
                  : deleting
                    ? 'providers.confirmDelete'
                    : 'providers.save',
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
