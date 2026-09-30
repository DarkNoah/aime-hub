import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Box,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { ProviderSummary, SyncResult } from '@aime/shared/providers';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { StatusBadge } from '@/components/status-badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  ProviderActionDialog,
  type ProviderAction,
} from '@/pages/admin/providers/components/provider-action-dialog';
import { ProviderModelsSection } from '@/pages/admin/providers/components/provider-models-section';
import { ModelDefaultsSection } from '@/pages/admin/providers/components/model-defaults-section';
import {
  modelPath,
  providerErrorKey,
  providerPath,
  providerRequest,
  providersPath,
} from '@/pages/admin/providers/api';
import { useProviderResource } from '@/pages/admin/providers/hooks/use-provider-resource';

export function AdminProvidersPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  const providers = useProviderResource<ProviderSummary[]>(
    providersPath,
    revision,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [action, setAction] = useState<ProviderAction | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [defaultsPending, setDefaultsPending] = useState(false);
  const focusTarget = useRef<HTMLElement | null>(null);
  const busy = pending || defaultsPending || !!action;

  const query = search.trim().toLocaleLowerCase();
  const filteredProviders = providers.data?.filter((provider) =>
    `${provider.name} ${provider.baseUrl} ${provider.type}`
      .toLocaleLowerCase()
      .includes(query),
  );

  function openAction(next: ProviderAction) {
    if (submitting.current || defaultsPending) return;
    focusTarget.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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
    try {
      const result = await providerRequest<SyncResult>(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      toast.success(
        sync ? t('models.synced', result) : t('providers.success'),
        {
          description:
            sync && !result.catalogAvailable
              ? t('models.catalogUnavailable')
              : undefined,
        },
      );
      setRevision((value) => value + 1);
    } catch (cause) {
      toast.error(t(providerErrorKey(cause)));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="min-w-0 space-y-8">
      <PageHeader
        title={t('nav.providers')}
        description={t('admin.providersDescription')}
        actions={
          <Button
            id="create-provider"
            disabled={busy}
            onClick={() => openAction({ kind: 'provider' })}
          >
            <Plus />
            {t('providers.create')}
          </Button>
        }
      />
      {!selected && pending && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('providers.working')}
        </p>
      )}
      <ModelDefaultsSection
        revision={revision}
        disabled={pending || !!action}
        onPendingChange={setDefaultsPending}
      />
      <section
        aria-labelledby="providers-heading"
        className="overflow-hidden rounded-xl border bg-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="providers-heading" className="text-sm font-semibold">
              {t('providers.list')}
            </h2>
            {providers.data && (
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                {providers.data.length}
              </span>
            )}
          </div>
          <div className="relative order-3 w-full sm:order-none sm:ml-auto sm:w-64">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-10 pl-9"
              aria-label={t('providers.search')}
              placeholder={t('providers.search')}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto sm:ml-0"
            disabled={providers.loading || busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw />
            {t('providers.refresh')}
          </Button>
        </div>
        <div aria-busy={providers.loading}>
          {providers.loading ? (
            <LoadingState label={t('providers.loading')} />
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
          ) : !filteredProviders?.length ? (
            <div className="flex min-h-52 flex-col items-center justify-center gap-2 p-8 text-center">
              <Plug
                className="mb-2 size-6 text-muted-foreground"
                strokeWidth={1.5}
              />
              <p className="font-medium">
                {t(query ? 'providers.noResults' : 'providers.empty')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(query ? 'models.searchHint' : 'providers.emptyHint')}
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {filteredProviders.map((provider) => (
                <li
                  key={provider.id}
                  className={`flex flex-wrap items-center justify-between gap-4 p-4 transition-colors hover:bg-muted/30 sm:p-5 ${selected === provider.id ? 'bg-primary/5' : ''}`}
                >
                  <span
                    aria-hidden="true"
                    className="hidden size-11 shrink-0 items-center justify-center rounded-lg border bg-background text-primary sm:flex"
                  >
                    <Plug className="size-5" strokeWidth={1.5} />
                  </span>
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-all font-medium">{provider.name}</h3>
                      <StatusBadge
                        tone={provider.enabled ? 'success' : 'neutral'}
                      >
                        {t(
                          provider.enabled
                            ? 'providers.enabled'
                            : 'providers.disabled',
                        )}
                      </StatusBadge>
                    </div>
                    <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground">
                      {provider.baseUrl}
                    </p>
                    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5">
                        {provider.type}
                      </span>
                      <Box className="ml-1 size-3.5" aria-hidden="true" />
                      {t('providers.modelCount', {
                        count: provider.modelCount,
                      })}{' '}
                      <KeyRound className="ml-2 size-3.5" aria-hidden="true" />
                      {t(
                        provider.hasApiKey
                          ? 'providers.keySet'
                          : 'providers.keyUnset',
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
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
                        setModelsOpen(true);
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
                    <Switch
                      checked={provider.enabled}
                      disabled={busy || providers.loading}
                      aria-label={t('providers.enableNamed', {
                        name: provider.name,
                      })}
                      className="mx-2"
                      onCheckedChange={(enabled) =>
                        void mutate(providerPath(provider.id), 'PATCH', {
                          enabled,
                        })
                      }
                    />
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
        <Sheet
          open={modelsOpen}
          onOpenChange={(open) => {
            if (!open && !busy) setModelsOpen(false);
          }}
        >
          <SheetContent
            side="right"
            showCloseButton={false}
            className="w-full overflow-y-auto p-4 sm:max-w-[1100px] sm:p-6"
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (busy) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              document.getElementById(`provider-models-${selected}`)?.focus();
              // Keep the contents mounted until the Sheet exit animation finishes.
              if (!modelsOpen) setSelected(null);
            }}
          >
            <SheetTitle className="sr-only">
              {t('models.title', {
                name:
                  providers.data?.find((provider) => provider.id === selected)
                    ?.name ?? selected,
              })}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {t('models.syncHint')}
            </SheetDescription>
            <ProviderModelsSection
              key={selected}
              providerId={selected}
              revision={revision}
              busy={busy}
              onAction={openAction}
              onClose={() => setModelsOpen(false)}
              onSync={() =>
                void mutate(
                  `${providerPath(selected)}/sync`,
                  'POST',
                  undefined,
                  true,
                )
              }
              onToggle={(model, enabled) =>
                void mutate(modelPath(selected, model.id), 'PATCH', {
                  enabled,
                })
              }
            />
          </SheetContent>
        </Sheet>
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
            toast.success(t('providers.success'));
            setRevision((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
