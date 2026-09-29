import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { ProviderModel, ProviderSummary } from '@aime/shared/providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
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
} from '@/lib/providers-api';
import type { ErrorKey } from '@/i18n/config';

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
  onSuccess: () => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const provider = action.kind === 'provider' ? action.provider : undefined;
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
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      if (action.kind === 'provider') {
        await providerRequest(
          provider ? providerPath(provider.id) : providersPath,
          {
            method: provider ? 'PATCH' : 'POST',
            body: JSON.stringify(providerFormInput(form)),
          },
        );
      } else if (action.kind === 'model') {
        await providerRequest(modelPath(action.providerId, model?.id), {
          method: model ? 'PATCH' : 'POST',
          body: JSON.stringify(modelFormInput(form)),
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
      onSuccess();
    } catch (cause) {
      setError(providerErrorKey(cause));
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
                  <Input id="provider-type" value="openai" readOnly />
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
                    {t('providers.urlHint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider-key">{t('providers.apiKey')}</Label>
                  <Input
                    id="provider-key"
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                    maxLength={4096}
                    disabled={clearApiKey}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(
                      provider ? 'providers.keyKeepHint' : 'providers.keyHint',
                    )}
                  </p>
                  {provider && (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          provider.hasApiKey
                            ? 'providers.keySet'
                            : 'providers.keyUnset',
                        )}
                      </p>
                      <Label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          name="clearApiKey"
                          checked={clearApiKey}
                          onChange={(event) =>
                            setClearApiKey(event.target.checked)
                          }
                        />
                        {t('providers.clearKey')}
                      </Label>
                    </>
                  )}
                </div>
                <Label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={provider?.enabled ?? true}
                  />
                  {t('providers.enabled')}
                </Label>
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
                <div className="flex flex-wrap gap-5">
                  {(['enabled', 'reasoning', 'toolCall'] as const).map(
                    (key) => (
                      <Label key={key} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          name={key}
                          defaultChecked={model?.[key] ?? key === 'enabled'}
                        />
                        {t(
                          key === 'enabled'
                            ? 'providers.enabled'
                            : `models.${key}`,
                        )}
                      </Label>
                    ),
                  )}
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
                          <Label
                            key={value}
                            className="flex items-center gap-2"
                          >
                            <input
                              type="checkbox"
                              name={key}
                              value={value}
                              defaultChecked={(
                                model?.[key] ?? ['text']
                              ).includes(value)}
                            />
                            {t(`models.modality.${value}`)}
                          </Label>
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
                    const preset =
                      limits[key] === ''
                        ? ''
                        : presets.some((k) => String(k * 1000) === limits[key])
                          ? limits[key]
                          : 'custom';
                    return (
                      <div key={key} className="min-w-0 space-y-2">
                        <Label htmlFor={`model-${key}`}>
                          {t(`models.${key}`)}
                        </Label>
                        <select
                          aria-label={t('models.limitPreset', {
                            field: t(`models.${key}`),
                          })}
                          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-ring"
                          value={preset}
                          onChange={(event) => {
                            if (event.target.value === 'custom') {
                              document.getElementById(`model-${key}`)?.focus();
                              return;
                            }
                            setLimits((current) => ({
                              ...current,
                              [key]: event.target.value,
                            }));
                          }}
                        >
                          <option value="">{t('models.modelDefault')}</option>
                          {presets.map((k) => (
                            <option key={k} value={String(k * 1000)}>
                              {k}k
                            </option>
                          ))}
                          <option value="custom">
                            {t('models.customLimit')}
                          </option>
                        </select>
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
                        <p
                          id={`model-${key}-hint`}
                          className="text-xs text-muted-foreground"
                        >
                          {t('models.limitHint')}
                        </p>
                      </div>
                    );
                  })}
                  {(['deprecated', 'passTest'] as const).map((key) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={`model-${key}`}>
                        {t(`models.${key}`)}
                      </Label>
                      <select
                        id={`model-${key}`}
                        name={key}
                        defaultValue={
                          model?.[key] == null ? 'null' : String(model[key])
                        }
                        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-ring"
                      >
                        <option value="null">
                          {t(
                            key === 'passTest'
                              ? 'models.untested'
                              : 'models.unknown',
                          )}
                        </option>
                        <option value="true">
                          {t(
                            key === 'passTest'
                              ? 'models.passed'
                              : 'models.deprecatedYes',
                          )}
                        </option>
                        <option value="false">
                          {t(
                            key === 'passTest'
                              ? 'models.failed'
                              : 'models.deprecatedNo',
                          )}
                        </option>
                      </select>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('models.testHint')}
                </p>
              </>
            )}
            {!deleting && (
              <div className="space-y-2">
                <Label htmlFor="provider-metadata">
                  {t('providers.metadata')}
                </Label>
                <Textarea
                  id="provider-metadata"
                  name="metadata"
                  className="min-h-28 font-mono"
                  spellCheck={false}
                  required
                  defaultValue={JSON.stringify(
                    provider?.metadata ?? model?.metadata ?? {},
                    null,
                    2,
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {t('providers.metadataHint')}
                </p>
              </div>
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
