import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Pencil,
  Plus,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { EnvironmentVariable as Variable } from '@aime/shared/environment-variables';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  EnvironmentVariable,
  EnvironmentVariableCopyButton,
  EnvironmentVariableName,
  EnvironmentVariableValue,
  EnvironmentVariables,
  EnvironmentVariablesContent,
  EnvironmentVariablesHeader,
  EnvironmentVariablesTitle,
  EnvironmentVariablesToggle,
} from '@/components/ai-elements/environment-variables';
import { environmentVariableErrorKey } from './api';
import {
  VariableDialog,
  type VariableAction,
} from './components/variable-dialog';

export function AdminEnvironmentVariablesPage() {
  const { t } = useTranslation();
  const [variables, setVariables] = useState<Variable[]>();
  const [error, setError] = useState<TranslationKey>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState<VariableAction>();
  const trigger = useRef<HTMLElement | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.environmentVariables
      .list(undefined, { signal: controller.signal })
      .then(
        (data) => {
          if (controller.signal.aborted) return;
          setVariables(data);
          setError(undefined);
          setLoading(false);
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(environmentVariableErrorKey(cause));
          setLoading(false);
        },
      );
    return () => controller.abort();
  }, [revision]);

  function refresh() {
    setLoading(true);
    setRevision((current) => current + 1);
  }
  function open(next: VariableAction, element: HTMLElement) {
    trigger.current = element;
    setAction(next);
  }
  function saved(variable: Variable) {
    setVariables((current = []) =>
      current.some((item) => item.id === variable.id)
        ? current.map((item) => (item.id === variable.id ? variable : item))
        : [...current, variable].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
  const query = search.trim().toLowerCase();
  const visible =
    variables?.filter((variable) =>
      `${variable.name} ${variable.description}`.toLowerCase().includes(query),
    ) ?? [];

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={t('nav.environmentVariables')}
        description={t('admin.environmentVariablesDescription')}
        actions={
          <Button
            ref={createButton}
            disabled={loading || !!error}
            onClick={(event) => open({ kind: 'create' }, event.currentTarget)}
          >
            <Plus />
            {t('environmentVariables.create')}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
            placeholder={t('environmentVariables.search')}
            aria-label={t('environmentVariables.search')}
          />
        </div>
        <Badge variant="secondary">
          {t('environmentVariables.count', { count: variables?.length ?? 0 })}
        </Badge>
        <Button
          variant="outline"
          size="icon"
          className="ml-auto"
          disabled={loading || !!action}
          onClick={refresh}
          aria-label={t('environmentVariables.refresh')}
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/25 p-4 text-sm text-destructive"
        >
          <span>{t(error)}</span>
          <Button variant="outline" disabled={loading} onClick={refresh}>
            {t('environmentVariables.retry')}
          </Button>
        </div>
      ) : null}
      {loading && !variables ? (
        <LoadingState />
      ) : variables ? (
        <EnvironmentVariables className="overflow-hidden rounded-xl bg-card">
          <EnvironmentVariablesHeader className="flex-wrap gap-3 bg-muted/30 px-5 py-4">
            <EnvironmentVariablesTitle>
              {t('environmentVariables.listTitle')}
            </EnvironmentVariablesTitle>
            <div className="flex items-center gap-2">
              <Label
                htmlFor="variables-visible"
                className="text-xs text-muted-foreground"
              >
                {t('environmentVariables.showValues')}
              </Label>
              <EnvironmentVariablesToggle
                id="variables-visible"
                aria-label={t('environmentVariables.showValues')}
              />
            </div>
          </EnvironmentVariablesHeader>
          <ScrollArea
            className="h-[min(60dvh,40rem)]"
            viewportProps={{ 'aria-busy': loading }}
          >
            <EnvironmentVariablesContent>
              {visible.length ? (
                visible.map((variable) => (
                  <EnvironmentVariable
                    key={variable.id}
                    name={variable.name}
                    value={variable.value}
                    className="flex-col items-stretch gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-6"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <EnvironmentVariableName className="block break-all font-medium" />
                      {variable.description ? (
                        <p className="line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
                          {variable.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex min-w-0 items-center gap-3 sm:w-1/2">
                      <div className="min-w-0 flex-1">
                        {variable.value === '' ? (
                          <span className="text-xs italic text-muted-foreground">
                            {t('environmentVariables.emptyValue')}
                          </span>
                        ) : (
                          <EnvironmentVariableValue className="block max-h-24 overflow-hidden break-all whitespace-pre-wrap" />
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <EnvironmentVariableCopyButton
                          className="size-8"
                          aria-label={t('environmentVariables.copyNamed', {
                            name: variable.name,
                          })}
                          onCopy={() =>
                            toast.success(t('environmentVariables.copied'))
                          }
                          onError={() =>
                            toast.error(t('environmentVariables.copyFailed'))
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={loading}
                          aria-label={t('environmentVariables.editNamed', {
                            name: variable.name,
                          })}
                          onClick={(event) =>
                            open(
                              { kind: 'edit', variable },
                              event.currentTarget,
                            )
                          }
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={loading}
                          aria-label={t('environmentVariables.deleteNamed', {
                            name: variable.name,
                          })}
                          onClick={(event) =>
                            open(
                              { kind: 'delete', variable },
                              event.currentTarget,
                            )
                          }
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </EnvironmentVariable>
                ))
              ) : (
                <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                  <TerminalSquare
                    className="size-8 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-medium">
                    {t(
                      query
                        ? 'environmentVariables.noMatches'
                        : 'environmentVariables.empty',
                    )}
                  </p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    {t(
                      query
                        ? 'environmentVariables.searchHint'
                        : 'environmentVariables.emptyHint',
                    )}
                  </p>
                </div>
              )}
            </EnvironmentVariablesContent>
          </ScrollArea>
        </EnvironmentVariables>
      ) : null}
      {action ? (
        <VariableDialog
          action={action}
          onClose={() => setAction(undefined)}
          onSaved={saved}
          onRemoved={(id) =>
            setVariables((current) =>
              current?.filter((variable) => variable.id !== id),
            )
          }
          restoreFocus={() => {
            const target = trigger.current?.isConnected
              ? trigger.current
              : createButton.current;
            target?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
