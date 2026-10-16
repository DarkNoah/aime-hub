import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  parsePluginConfig,
  type PluginConfiguration,
  type PluginStatus,
  type PluginConfigIssue,
} from '@app/plugin-sdk';
import { pluginRequest, PluginRequestError } from '@app/plugin-sdk/web';
import { usePlugins } from '@/features/plugins/context';
import { LoadingState } from '@/components/loading-state';
import { Button } from '@/components/ui/button';
import { PluginConfigFields } from './config-fields';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

export function PluginConfigDialog({
  plugin,
  onClose,
  restoreFocus,
}: {
  plugin: PluginStatus;
  onClose(): void;
  restoreFocus(): void;
}) {
  const { t } = useTranslation();
  const { saveConfig } = usePlugins();
  const [configuration, setConfiguration] =
    useState<PluginConfiguration | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [issues, setIssues] = useState<PluginConfigIssue[]>([]);
  const [activeGroup, setActiveGroup] = useState(
    plugin.configFields[0]?.group ?? '',
  );
  const showIssues = (next: PluginConfigIssue[]) => {
    setIssues(next);
    const field = plugin.configFields.find((item) =>
      next.some((issue) => issue.field === item.key),
    );
    if (field) setActiveGroup(field.group ?? '');
  };
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const submitting = useRef(false);
  const loadConfig = useCallback(
    (signal?: AbortSignal) =>
      pluginRequest<PluginConfiguration>(plugin.id, '/config', { signal })
        .then((result) => {
          if (signal?.aborted) return;
          setConfiguration(result);
          setValues(
            Object.fromEntries(
              Object.entries(result.config).map(([key, value]) => [
                key,
                typeof value === 'boolean' ? value : String(value),
              ]),
            ),
          );
          setLoadFailed(false);
          setIssues([]);
          setError('');
          setConflict(false);
        })
        .catch(() => {
          if (!signal?.aborted) setLoadFailed(true);
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        }),
    [plugin.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    return () => controller.abort();
  }, [loadConfig]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !configuration) return;
    const input = Object.fromEntries(
      plugin.configFields.flatMap<[string, string | number | boolean]>(
        (field) => {
          const value = values[field.key];
          if (field.type === 'number')
            return String(value ?? '').trim()
              ? [[field.key, Number(value)]]
              : [];
          return [
            [
              field.key,
              field.type === 'boolean' ? value === true : String(value ?? ''),
            ],
          ];
        },
      ),
    );
    const parsed = parsePluginConfig(plugin.configFields, input);
    showIssues(parsed.success ? [] : parsed.issues);
    setError('');
    if (!parsed.success) return;
    submitting.current = true;
    setPending(true);
    try {
      const result = await saveConfig(plugin.id, {
        config: parsed.data,
        revision: configuration.revision,
      });
      setConfiguration(result.configuration);
      if (!result.applied) {
        setError(t('plugins.configApplyFailed'));
        toast.error(t('plugins.configApplyFailed'));
        return;
      }
      toast.success(t('plugins.configSaved'));
      onClose();
    } catch (cause) {
      const stale =
        cause instanceof Error && cause.message === 'PLUGIN_CONFIG_CONFLICT';
      const message = t(
        stale ? 'plugins.configConflict' : 'plugins.configSaveFailed',
      );
      setError(message);
      setConflict(stale);
      if (cause instanceof PluginRequestError) showIssues(cause.issues ?? []);
      toast.error(message);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  const reload = () => {
    setLoading(true);
    void loadConfig();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col sm:max-w-xl"
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
          <DialogTitle>
            {t('plugins.configTitle', { name: plugin.name })}
          </DialogTitle>
          <DialogDescription>
            {t(
              plugin.desiredEnabled
                ? 'plugins.configActiveHint'
                : 'plugins.configHint',
            )}
          </DialogDescription>
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
            {loading ? (
              <LoadingState />
            ) : loadFailed ? (
              <div role="alert" className="space-y-3 p-1">
                <p className="text-sm text-destructive">
                  {t('plugins.configLoadFailed')}
                </p>
                <Button type="button" variant="outline" onClick={reload}>
                  {t('plugins.configReload')}
                </Button>
              </div>
            ) : (
              <fieldset disabled={pending} className="min-w-0 space-y-5 p-1">
                <PluginConfigFields
                  pluginId={plugin.id}
                  fields={plugin.configFields}
                  values={values}
                  issues={issues}
                  disabled={pending}
                  activeGroup={activeGroup}
                  onGroupChange={setActiveGroup}
                  onChange={(key, value) => {
                    setValues((current) => ({ ...current, [key]: value }));
                    setIssues([]);
                  }}
                />
                {issues.some((issue) => !issue.field) && (
                  <p role="alert" className="text-sm text-destructive">
                    {t('plugins.configInvalid')}
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                {conflict && (
                  <Button type="button" variant="outline" onClick={reload}>
                    {t('plugins.configReloadConflict')}
                  </Button>
                )}
              </fieldset>
            )}
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('plugins.configCancel')}
            </Button>
            <Button
              type="submit"
              disabled={loading || loadFailed || pending || conflict}
            >
              {pending && <Loader2 className="animate-spin" />}
              {t(
                pending
                  ? 'plugins.configSaving'
                  : plugin.desiredEnabled
                    ? 'plugins.configSaveApply'
                    : 'plugins.configSave',
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
