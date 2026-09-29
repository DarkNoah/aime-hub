import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import type { ProviderDetail, ProviderModel } from '@aime/shared/providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProviderAction } from '@/components/provider-action-dialog';
import { modelPath, providerPath } from '@/lib/providers-api';
import { useProviderResource } from '@/lib/use-provider-resource';

export function ProviderModelsSection({
  providerId,
  revision,
  busy,
  onAction,
  onSync,
  onToggle,
  onClose,
}: {
  providerId: string;
  revision: number;
  busy: boolean;
  onAction: (action: ProviderAction) => void;
  onSync: () => void;
  onToggle: (model: ProviderModel) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [retry, setRetry] = useState(0);
  const detail = useProviderResource<ProviderDetail>(
    providerPath(providerId),
    revision + retry,
  );
  const models = useProviderResource<ProviderModel[]>(
    modelPath(providerId),
    revision + retry,
  );
  const loading = detail.loading || models.loading;
  const error = detail.error || models.error;
  const query = search.trim().toLocaleLowerCase();
  const filtered = (models.data ?? []).filter((model) =>
    [model.id, model.name, model.displayName, model.description].some((value) =>
      value?.toLocaleLowerCase().includes(query),
    ),
  );
  return (
    <section
      aria-labelledby="provider-models-heading"
      className="min-w-0 shrink-0 overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:p-5">
        <div className="min-w-0">
          <h2
            id="provider-models-heading"
            tabIndex={-1}
            className="break-all font-semibold"
          >
            {t('models.title', { name: detail.data?.name ?? providerId })}
          </h2>
          <p className="mt-2 break-all text-xs text-muted-foreground">
            {detail.data?.baseUrl}
          </p>
        </div>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t('models.close')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b p-4 sm:p-5">
        <Input
          className="min-w-0 sm:max-w-sm"
          aria-label={t('models.search')}
          placeholder={t('models.search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button
          variant="outline"
          disabled={busy || loading || !!error}
          onClick={onSync}
        >
          <RefreshCw />
          {t('models.sync')}
        </Button>
        <Button
          disabled={busy || loading || !!error}
          onClick={() => onAction({ kind: 'model', providerId })}
        >
          <Plus />
          {t('models.create')}
        </Button>
      </div>
      <div aria-busy={loading}>
        {loading ? (
          <p
            role="status"
            className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            {t('providers.loading')}
          </p>
        ) : error ? (
          <div className="space-y-4 p-6">
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('providers.retry')}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="space-y-2 p-8 text-center">
            <p>{t(query ? 'models.noResults' : 'models.empty')}</p>
            <p className="text-sm text-muted-foreground">
              {t(query ? 'models.searchHint' : 'models.emptyHint')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <caption className="sr-only">
                {t('models.title', { name: detail.data?.name ?? providerId })}
              </caption>
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  {(
                    [
                      'models.name',
                      'models.capabilities',
                      'models.limits',
                      'providers.status',
                      'providers.actions',
                    ] as const
                  ).map((key) => (
                    <th key={key} scope="col" className="px-5 py-3 font-medium">
                      {t(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((model) => (
                  <tr key={model.id}>
                    <td className="max-w-72 px-5 py-4">
                      <p className="break-words font-medium">
                        {model.displayName || model.name}
                      </p>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {model.id}
                      </p>
                      {model.description && (
                        <p
                          className="mt-2 line-clamp-2 break-words text-xs text-muted-foreground"
                          title={model.description}
                        >
                          {model.description}
                        </p>
                      )}
                    </td>
                    <td className="space-y-1 px-5 py-4 text-xs">
                      <p>
                        {t('models.modalitiesInput')}:{' '}
                        {model.modalitiesInput
                          .map((value) => t(`models.modality.${value}`))
                          .join(', ') || '—'}
                      </p>
                      <p>
                        {t('models.modalitiesOutput')}:{' '}
                        {model.modalitiesOutput
                          .map((value) => t(`models.modality.${value}`))
                          .join(', ') || '—'}
                      </p>
                      <p>
                        {t('models.reasoning')}:{' '}
                        {t(model.reasoning ? 'providers.yes' : 'providers.no')}
                      </p>
                      <p>
                        {t('models.toolCall')}:{' '}
                        {t(model.toolCall ? 'providers.yes' : 'providers.no')}
                      </p>
                    </td>
                    <td className="space-y-1 whitespace-nowrap px-5 py-4 text-xs">
                      <p>
                        {t('models.limitContext')}:{' '}
                        {model.limitContext ?? t('models.modelDefault')}
                      </p>
                      <p>
                        {t('models.limitOutput')}:{' '}
                        {model.limitOutput ?? t('models.modelDefault')}
                      </p>
                    </td>
                    <td className="space-y-1 whitespace-nowrap px-5 py-4 text-xs">
                      <p
                        className={
                          model.enabled
                            ? 'text-primary'
                            : 'text-muted-foreground'
                        }
                      >
                        {t(
                          model.enabled
                            ? 'providers.enabled'
                            : 'providers.disabled',
                        )}
                      </p>
                      <p>
                        {t('models.deprecated')}:{' '}
                        {t(
                          model.deprecated === null
                            ? 'models.unknown'
                            : model.deprecated
                              ? 'providers.yes'
                              : 'providers.no',
                        )}
                      </p>
                      <p>
                        {t('models.passTest')}:{' '}
                        {t(
                          model.passTest === null
                            ? 'models.untested'
                            : model.passTest
                              ? 'models.passed'
                              : 'models.failed',
                        )}
                      </p>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            onAction({ kind: 'model', providerId, model })
                          }
                        >
                          {t('providers.editAction')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => onToggle(model)}
                        >
                          {t(
                            model.enabled
                              ? 'providers.disable'
                              : 'providers.enable',
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={busy}
                          onClick={() =>
                            onAction({ kind: 'deleteModel', model })
                          }
                        >
                          {t('providers.deleteAction')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="border-t px-5 py-4 text-xs leading-6 text-muted-foreground">
        {t('models.syncHint')}
      </p>
    </section>
  );
}
