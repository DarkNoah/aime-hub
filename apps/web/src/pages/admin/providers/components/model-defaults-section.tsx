import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  modelDefaultsSchema,
  type ModelDefaults,
  defaultModelKeys,
  defaultModelTypes,
  defaultWebProviderKeys,
  defaultWebProviderTools,
  type ProviderSummary,
} from '@aime/shared/providers';
import { thinkingLevels } from '@aime/shared/threads';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { WebProviderSelector } from '@/components/web-provider-selector';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { providerErrorKey, providerApi } from '@/pages/admin/providers/api';
import { modelOptions } from '@/components/model-selector/model-options';
import { useAvailableModels } from '@/features/models/use-available-models';
import { ModelSelector } from '@/components/model-selector';
import type { ErrorKey } from '@/i18n/config';

const modelGroups = [
  { id: 'conversation', fields: ['defaultModel', 'fastModel'] },
  { id: 'media', fields: ['imageModel', 'speechModel', 'asrModel'] },
  { id: 'knowledge', fields: ['embeddingModel', 'rerankModel', 'ocrModel'] },
] as const;

export function ModelDefaultsSection({
  revision,
  providers,
  disabled,
  onPendingChange,
}: {
  revision: number;
  providers: ProviderSummary[];
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const available = useAvailableModels();
  const [retry, setRetry] = useState(0);
  const key = `${revision}/${retry}`;
  const [result, setResult] = useState<{
    key: string;
    defaults?: ModelDefaults;
    error?: ErrorKey;
  }>();
  const [draft, setDraft] = useState<ModelDefaults | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const loading =
    result?.key !== key || (available.loading && !available.defaults);
  const controlsDisabled = pending || disabled || available.loading;
  const loadError = available.error ?? result?.error;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const defaults = await providerApi.defaults(controller.signal);
        if (!controller.signal.aborted) setResult({ key, defaults });
      } catch (cause) {
        if (!controller.signal.aborted)
          setResult({ key, error: providerErrorKey(cause) });
      }
    }
    void load();
    return () => controller.abort();
  }, [key]);

  const value = draft ?? result?.defaults;
  const choicesFor = (field: (typeof defaultModelKeys)[number]) =>
    modelOptions(
      available.providers,
      available.models,
      defaultModelTypes[field],
    );
  async function change<K extends keyof ModelDefaults>(
    field: K,
    next: ModelDefaults[K],
  ) {
    if (
      submitting.current ||
      disabled ||
      available.loading ||
      loading ||
      loadError ||
      !value ||
      value[field] === next
    )
      return;
    const nextDefaults = { ...value, [field]: next };
    const parsed = modelDefaultsSchema.safeParse(nextDefaults);
    if (!parsed.success) {
      setError('errors.providerValidation');
      return;
    }
    if (
      defaultModelKeys.some(
        (field) =>
          nextDefaults[field] !== null &&
          !choicesFor(field).some(
            (option) => option.value === nextDefaults[field],
          ),
      )
    ) {
      setError('errors.invalidModel');
      return;
    }
    setDraft(nextDefaults);
    submitting.current = true;
    setPending(true);
    onPendingChange(true);
    setError(null);
    try {
      const saved = await providerApi.saveDefaults(parsed.data);
      setResult((current) =>
        current ? { ...current, defaults: saved } : current,
      );
      toast.success(t('defaults.saved'));
    } catch (cause) {
      toast.error(t(providerErrorKey(cause)));
    } finally {
      setDraft(null);
      submitting.current = false;
      setPending(false);
      onPendingChange(false);
    }
  }

  return (
    <section
      aria-labelledby="model-defaults-heading"
      className="min-w-0 rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-5 sm:px-6">
        <div className="min-w-0 space-y-1.5">
          <h2 id="model-defaults-heading" className="text-base font-semibold">
            {t('defaults.title')}
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {t('defaults.hint')}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 gap-1.5" role="status">
          {pending && (
            <Loader2
              className="size-3 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          {t(pending ? 'providers.saving' : 'defaults.autoSave')}
        </Badge>
      </div>
      {loading ? (
        <LoadingState label={t('providers.loading')} className="px-5 sm:px-6" />
      ) : loadError ? (
        <div className="space-y-3 px-5 pb-5 sm:px-6">
          <p role="alert" className="text-sm text-destructive">
            {t(loadError)}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void available.refresh();
              setRetry((current) => current + 1);
            }}
          >
            {t('providers.retry')}
          </Button>
        </div>
      ) : (
        value && (
          <div aria-busy={pending}>
            {modelGroups.map((group) => (
              <fieldset
                key={group.id}
                disabled={controlsDisabled}
                aria-labelledby={`defaults-group-${group.id}`}
                className="grid min-w-0 gap-4 border-t px-5 py-5 sm:px-6 lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-6"
              >
                <div>
                  <h3
                    id={`defaults-group-${group.id}`}
                    className="text-sm font-medium"
                  >
                    {t(`defaults.group.${group.id}`)}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t(`defaults.group.${group.id}Hint`)}
                  </p>
                </div>
                <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {group.fields.map((field) => (
                    <div key={field} className="min-w-0 space-y-2">
                      <Label htmlFor={`defaults-${field}`}>
                        {t(`defaults.${field}`)}
                      </Label>
                      <ModelSelector
                        id={`defaults-${field}`}
                        label={t(`defaults.${field}`)}
                        modelType={defaultModelTypes[field]}
                        noneLabel={t('defaults.none')}
                        emptyHint={t(
                          field === 'imageModel'
                            ? 'defaults.noImages'
                            : 'defaults.noModels',
                        )}
                        value={value[field]}
                        onValueChange={(next) => void change(field, next)}
                        disabled={controlsDisabled}
                      />
                    </div>
                  ))}
                  {group.id === 'conversation' && (
                    <div className="min-w-0 space-y-2">
                      <Label htmlFor="defaults-thinkingMode">
                        {t('defaults.thinkingMode')}
                      </Label>
                      <Select
                        value={value.thinkingMode}
                        onValueChange={(next) =>
                          void change(
                            'thinkingMode',
                            next as ModelDefaults['thinkingMode'],
                          )
                        }
                        disabled={controlsDisabled}
                      >
                        <SelectTrigger
                          id="defaults-thinkingMode"
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {thinkingLevels.map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              {t(`chat.reasoning.${mode}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </fieldset>
            ))}
            <fieldset
              disabled={controlsDisabled}
              aria-labelledby="defaults-group-web"
              className="grid min-w-0 gap-4 border-t px-5 py-5 sm:px-6 lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-6"
            >
              <div>
                <h3 id="defaults-group-web" className="text-sm font-medium">
                  {t('defaults.group.web')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t('defaults.group.webHint')}
                </p>
              </div>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {defaultWebProviderKeys.map((field) => (
                  <div key={field} className="min-w-0 space-y-2">
                    <Label htmlFor={`defaults-${field}`}>
                      {t(`defaults.${field}`)}
                    </Label>
                    <WebProviderSelector
                      id={`defaults-${field}`}
                      tool={defaultWebProviderTools[field]}
                      providers={providers}
                      value={value[field]}
                      onValueChange={(next) => void change(field, next)}
                      noneLabel={t(
                        field === 'webSearchProviderId'
                          ? 'tools.sogou'
                          : 'tools.localFetch',
                      )}
                      disabled={controlsDisabled}
                      describedBy={`defaults-${field}-hint`}
                    />
                    <p
                      id={`defaults-${field}-hint`}
                      className="text-xs leading-5 text-muted-foreground"
                    >
                      {t(
                        field === 'webSearchProviderId'
                          ? 'defaults.searchHint'
                          : 'defaults.fetchHint',
                      )}
                    </p>
                  </div>
                ))}
              </div>
            </fieldset>
            {error && (
              <p
                role="alert"
                className="px-5 pb-5 text-sm text-destructive sm:px-6"
              >
                {t(error)}
              </p>
            )}
          </div>
        )
      )}
    </section>
  );
}
