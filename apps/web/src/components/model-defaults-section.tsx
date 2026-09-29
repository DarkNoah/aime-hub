import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  modelDefaultsSchema,
  type ModelDefaults,
  type ProviderModel,
  type ProviderSummary,
} from '@aime/shared/providers';
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
  modelOptions,
  modelPath,
  providerErrorKey,
  providerRequest,
  providersPath,
} from '@/lib/providers-api';
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
  const [retry, setRetry] = useState(0);
  const key = `${revision}/${retry}`;
  const [result, setResult] = useState<{
    key: string;
    defaults?: ModelDefaults;
    providers?: ProviderSummary[];
    models?: ProviderModel[];
    error?: ErrorKey;
  }>();
  const [draft, setDraft] = useState<ModelDefaults | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [success, setSuccess] = useState(false);
  const loading = result?.key !== key;

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    async function load() {
      try {
        const [defaults, providers] = await Promise.all([
          providerRequest<ModelDefaults>(defaultsPath, options),
          providerRequest<ProviderSummary[]>(providersPath, options),
        ]);
        const models = (
          await Promise.all(
            providers
              .filter((provider) => provider.enabled)
              .map((provider) =>
                providerRequest<ProviderModel[]>(
                  modelPath(provider.id),
                  options,
                ),
              ),
          )
        ).flat();
        if (!controller.signal.aborted)
          setResult({ key, defaults, providers, models });
      } catch (cause) {
        if (!controller.signal.aborted)
          setResult({ key, error: providerErrorKey(cause) });
      }
    }
    void load();
    return () => controller.abort();
  }, [key]);

  const value = draft ?? result?.defaults;
  const options = modelOptions(result?.providers ?? [], result?.models ?? []);
  const imageOptions = modelOptions(
    result?.providers ?? [],
    result?.models ?? [],
    true,
  );
  function change<K extends keyof ModelDefaults>(
    field: K,
    next: ModelDefaults[K],
  ) {
    if (!value) return;
    setDraft({ ...value, [field]: next });
    setSuccess(false);
    setError(null);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || disabled || loading || !value) return;
    const parsed = modelDefaultsSchema.safeParse(value);
    if (!parsed.success) {
      setError('errors.providerValidation');
      return;
    }
    if (
      (['defaultModel', 'fastModel', 'imageModel'] as const).some(
        (field) =>
          value[field] !== null &&
          !(field === 'imageModel' ? imageOptions : options).some(
            (option) => option.value === value[field],
          ),
      )
    ) {
      setError('errors.invalidModel');
      return;
    }
    submitting.current = true;
    setPending(true);
    onPendingChange(true);
    setError(null);
    setSuccess(false);
    try {
      const saved = await providerRequest<ModelDefaults>(defaultsPath, {
        method: 'PUT',
        body: JSON.stringify(parsed.data),
      });
      setResult((current) =>
        current ? { ...current, defaults: saved } : current,
      );
      setDraft(null);
      setSuccess(true);
    } catch (cause) {
      setError(providerErrorKey(cause));
    } finally {
      submitting.current = false;
      setPending(false);
      onPendingChange(false);
    }
  }

  return (
    <section
      aria-labelledby="model-defaults-heading"
      className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5"
    >
      <div>
        <h2 id="model-defaults-heading" className="font-semibold">
          {t('defaults.title')}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t('defaults.hint')}
        </p>
      </div>
      {loading ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" />
          {t('providers.loading')}
        </p>
      ) : result?.error ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {t(result.error)}
          </p>
          <Button
            variant="outline"
            onClick={() => setRetry((current) => current + 1)}
          >
            {t('providers.retry')}
          </Button>
        </div>
      ) : (
        value && (
          <form onSubmit={save} className="space-y-4">
            <fieldset
              disabled={pending || disabled}
              className="grid min-w-0 gap-4 md:grid-cols-2"
            >
              {(['defaultModel', 'fastModel', 'imageModel'] as const).map(
                (field) => {
                  const choices =
                    field === 'imageModel' ? imageOptions : options;
                  const unavailable =
                    value[field] !== null &&
                    !choices.some((option) => option.value === value[field]);
                  return (
                    <div key={field} className="min-w-0 space-y-2">
                      <Label htmlFor={`defaults-${field}`}>
                        {t(`defaults.${field}`)}
                      </Label>
                      <Select
                        value={value[field] ?? '__none__'}
                        onValueChange={(next) =>
                          change(field, next === '__none__' ? null : next)
                        }
                        disabled={pending || disabled}
                      >
                        <SelectTrigger
                          id={`defaults-${field}`}
                          className="w-full min-w-0"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-w-[calc(100vw-2rem)]">
                          <SelectItem value="__none__">
                            {t('defaults.none')}
                          </SelectItem>
                          {unavailable && (
                            <SelectItem value={value[field]!} disabled>
                              {t('defaults.unavailable', {
                                reference: value[field]!,
                              })}
                            </SelectItem>
                          )}
                          {choices.map((option) => (
                            <SelectItem
                              key={option.value}
                              value={option.value}
                              className="break-all"
                            >
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                    change(
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
                    {(['auto', 'on', 'off'] as const).map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(`defaults.${mode}`)}
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
            {success && (
              <p role="status" className="text-sm text-primary">
                {t('defaults.saved')}
              </p>
            )}
            <Button type="submit" disabled={pending || disabled}>
              {pending && <Loader2 className="animate-spin" />}
              {t(pending ? 'providers.saving' : 'defaults.save')}
            </Button>
          </form>
        )
      )}
    </section>
  );
}
