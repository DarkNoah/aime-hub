import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  modelDefaultsSchema,
  type ModelDefaults,
} from '@aime/shared/providers';
import { thinkingLevels } from '@aime/shared/threads';
import { invalidateAvailableModels } from '@/features/models/resource';
import { LoadingState } from '@/components/loading-state';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  defaultsPath,
  providerErrorKey,
  providerRequest,
} from '@/pages/admin/providers/api';
import { modelOptions } from '@/components/model-selector/model-options';
import { useAvailableModels } from '@/features/models/use-available-models';
import { ModelSelector } from '@/components/model-selector';
import type { ErrorKey } from '@/i18n/config';

export function ModelDefaultsSection({
  revision,
  disabled,
  onPendingChange,
}: {
  revision: number;
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
  const loading = available.loading || result?.key !== key;
  const loadError = available.error ?? result?.error;

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    async function load() {
      try {
        const defaults = await providerRequest<ModelDefaults>(
          defaultsPath,
          options,
        );
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
  const options = modelOptions(available.providers, available.models);
  const imageOptions = modelOptions(
    available.providers,
    available.models,
    true,
  );
  async function change<K extends keyof ModelDefaults>(
    field: K,
    next: ModelDefaults[K],
  ) {
    if (
      submitting.current ||
      disabled ||
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
      (['defaultModel', 'fastModel', 'imageModel'] as const).some(
        (field) =>
          nextDefaults[field] !== null &&
          !(field === 'imageModel' ? imageOptions : options).some(
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
      const saved = await providerRequest<ModelDefaults>(defaultsPath, {
        method: 'PUT',
        body: JSON.stringify(parsed.data),
      });
      setResult((current) =>
        current ? { ...current, defaults: saved } : current,
      );
      invalidateAvailableModels();
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
      className="space-y-5 rounded-xl border bg-card p-5 sm:p-6"
    >
      <div>
        <h2 id="model-defaults-heading" className="text-sm font-semibold">
          {t('defaults.title')}
        </h2>
        <p className="mt-2 max-w-3xl text-xs leading-6 text-muted-foreground">
          {t('defaults.hint')}
        </p>
      </div>
      {loading ? (
        <LoadingState label={t('providers.loading')} className="px-0" />
      ) : loadError ? (
        <div className="space-y-3">
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
          <div className="space-y-4" aria-busy={pending}>
            <fieldset
              disabled={pending || disabled}
              className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4"
            >
              {(['defaultModel', 'fastModel', 'imageModel'] as const).map(
                (field) => {
                  const choices =
                    field === 'imageModel' ? imageOptions : options;
                  return (
                    <div key={field} className="min-w-0 space-y-2">
                      <Label htmlFor={`defaults-${field}`}>
                        {t(`defaults.${field}`)}
                      </Label>
                      <ModelSelector
                        id={`defaults-${field}`}
                        label={t(`defaults.${field}`)}
                        imageOnly={field === 'imageModel'}
                        noneLabel={t('defaults.none')}
                        emptyHint={t(
                          field === 'imageModel'
                            ? 'defaults.noImages'
                            : 'defaults.noModels',
                        )}
                        value={value[field]}
                        onValueChange={(next) => void change(field, next)}
                        disabled={pending || disabled}
                      />
                      {choices.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          {t(
                            field === 'imageModel'
                              ? 'defaults.noImages'
                              : 'defaults.noModels',
                          )}
                        </p>
                      )}
                    </div>
                  );
                },
              )}
              <div className="space-y-2">
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
                  disabled={pending || disabled}
                >
                  <SelectTrigger id="defaults-thinkingMode" className="w-full">
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
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {t(error)}
              </p>
            )}
            {pending && (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t('providers.saving')}
              </p>
            )}
          </div>
        )
      )}
    </section>
  );
}
