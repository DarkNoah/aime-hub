import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import type { ProviderSummary, SyncResult } from '@aime/shared/providers';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  ProviderActionDialog,
  type ProviderAction,
} from '@/components/provider-action-dialog';
import { ProviderModelsSection } from '@/components/provider-models-section';
import { ModelDefaultsSection } from '@/components/model-defaults-section';
import {
  modelPath,
  providerErrorKey,
  providerPath,
  providerRequest,
  providersPath,
} from '@/lib/providers-api';
import { useProviderResource } from '@/lib/use-provider-resource';
import type { ErrorKey } from '@/i18n/config';

export function AdminProvidersPage() {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  const providers = useProviderResource<ProviderSummary[]>(
    providersPath,
    revision,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<ProviderAction | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [defaultsPending, setDefaultsPending] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [success, setSuccess] = useState<boolean | SyncResult>(false);
  const focusTarget = useRef<HTMLElement | null>(null);
  const busy = pending || defaultsPending || !!action;

  function openAction(next: ProviderAction) {
    if (submitting.current || defaultsPending) return;
    focusTarget.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setError(null);
    setSuccess(false);
    setAction(next);
  }
  async function mutate(
    path: string,
    method: string,
    body?: unknown,
    sync = false,
  ) {
    if (submitting.current || defaultsPending || action) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await providerRequest<SyncResult>(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      setSuccess(sync ? result : true);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(providerErrorKey(cause));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="min-w-0 space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="mb-3 text-xs font-medium tracking-[0.18em] text-primary">
            {t('admin.eyebrow')}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('nav.providers')}
          </h1>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            {t('admin.providersDescription')}
          </p>
        </div>
        <Button
          id="create-provider"
          disabled={busy}
          onClick={() => openAction({ kind: 'provider' })}
        >
          <Plus />
          {t('providers.create')}
        </Button>
      </section>
      <ModelDefaultsSection
        revision={revision}
        disabled={pending || !!action}
        onPendingChange={setDefaultsPending}
      />
      {!selected && pending && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('providers.working')}
        </p>
      )}
      {!selected && error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {t(error)}
        </p>
      )}
      {!selected && success && (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm"
        >
          <p>
            {typeof success === 'boolean'
              ? t('providers.success')
              : t('models.synced', success)}
          </p>
          {typeof success !== 'boolean' && !success.catalogAvailable && (
            <p>{t('models.catalogUnavailable')}</p>
          )}
        </div>
      )}
      <section
        aria-labelledby="providers-heading"
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:p-5">
          <h2 id="providers-heading" className="font-semibold">
            {t('providers.list')}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={providers.loading || busy}
            onClick={() => {
              setRevision((value) => value + 1);
              setSuccess(false);
              setError(null);
            }}
          >
            <RefreshCw />
            {t('providers.refresh')}
          </Button>
        </div>
        <div aria-busy={providers.loading}>
          {providers.loading ? (
            <p
              role="status"
              className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin" />
              {t('providers.loading')}
            </p>
          ) : providers.error ? (
            <div className="space-y-4 p-6">
              <p role="alert" className="text-sm text-destructive">
                {t(providers.error)}
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRevision((value) => value + 1)}
              >
                {t('providers.retry')}
              </Button>
            </div>
          ) : !providers.data?.length ? (
            <div className="space-y-2 p-8 text-center">
              <p>{t('providers.empty')}</p>
              <p className="text-sm text-muted-foreground">
                {t('providers.emptyHint')}
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {providers.data.map((provider) => (
                <li
                  key={provider.id}
                  className={`flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5 ${selected === provider.id ? 'bg-primary/5' : ''}`}
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-all font-medium">{provider.name}</h3>
                      <span className="rounded-full bg-muted px-2 py-1 text-xs">
                        {t(
                          provider.enabled
                            ? 'providers.enabled'
                            : 'providers.disabled',
                        )}
                      </span>
                    </div>
                    <p className="mt-2 break-all text-xs text-muted-foreground">
                      {provider.baseUrl}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {provider.type} ·{' '}
                      {t('providers.modelCount', {
                        count: provider.modelCount,
                      })}{' '}
                      ·{' '}
                      {t(
                        provider.hasApiKey
                          ? 'providers.keySet'
                          : 'providers.keyUnset',
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant={
                        selected === provider.id ? 'secondary' : 'outline'
                      }
                      size="sm"
                      disabled={busy}
                      id={`provider-models-${provider.id}`}
                      aria-haspopup="dialog"
                      aria-expanded={selected === provider.id}
                      onClick={() => {
                        setSelected(provider.id);
                        setError(null);
                        setSuccess(false);
                      }}
                    >
                      {t('providers.models')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => openAction({ kind: 'provider', provider })}
                    >
                      {t('providers.editAction')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void mutate(providerPath(provider.id), 'PATCH', {
                          enabled: !provider.enabled,
                        })
                      }
                    >
                      {t(
                        provider.enabled
                          ? 'providers.disable'
                          : 'providers.enable',
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={busy}
                      onClick={() =>
                        openAction({ kind: 'deleteProvider', provider })
                      }
                    >
                      {t('providers.deleteAction')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {selected && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setSelected(null);
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="flex flex-col overflow-y-auto rounded-none p-4 sm:p-6"
            style={{
              top: 0,
              right: 0,
              left: 'auto',
              transform: 'none',
              translate: 'none',
              height: '100dvh',
              width: 'min(100vw, 1100px)',
              maxWidth: '100vw',
            }}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (busy) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              document.getElementById(`provider-models-${selected}`)?.focus();
            }}
          >
            <DialogTitle className="sr-only">
              {t('models.title', {
                name:
                  providers.data?.find((provider) => provider.id === selected)
                    ?.name ?? selected,
              })}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t('models.syncHint')}
            </DialogDescription>
            {pending && (
              <p role="status" className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" />
                {t('providers.working')}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
              >
                {t(error)}
              </p>
            )}
            {success && (
              <div
                role="status"
                className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm"
              >
                <p>
                  {typeof success === 'boolean'
                    ? t('providers.success')
                    : t('models.synced', success)}
                </p>
                {typeof success !== 'boolean' && !success.catalogAvailable && (
                  <p>{t('models.catalogUnavailable')}</p>
                )}
              </div>
            )}
            <ProviderModelsSection
              key={selected}
              providerId={selected}
              revision={revision}
              busy={busy}
              onAction={openAction}
              onClose={() => setSelected(null)}
              onSync={() =>
                void mutate(
                  `${providerPath(selected)}/sync`,
                  'POST',
                  undefined,
                  true,
                )
              }
              onToggle={(model) =>
                void mutate(modelPath(selected, model.id), 'PATCH', {
                  enabled: !model.enabled,
                })
              }
            />
          </DialogContent>
        </Dialog>
      )}
      {action && (
        <ProviderActionDialog
          action={action}
          onClose={() => setAction(null)}
          restoreFocus={() => {
            const target = focusTarget.current;
            if (target?.isConnected && !target.matches(':disabled'))
              target.focus();
            else if (selected)
              document.getElementById('provider-models-heading')?.focus();
            else document.getElementById('create-provider')?.focus();
          }}
          onSuccess={() => {
            if (
              action.kind === 'deleteProvider' &&
              action.provider.id === selected
            )
              setSelected(null);
            setAction(null);
            setSuccess(true);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
