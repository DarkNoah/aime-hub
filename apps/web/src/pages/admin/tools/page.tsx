import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  Globe,
  ImagePlus,
  AudioLines,
  Wrench,
  Settings2,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ToolConfig } from '@aime/shared/tools';
import type { ProviderSummary } from '@aime/shared/providers';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { WebToolDialog } from './components/web-tool-dialog';
import { ModelToolDialog } from './components/model-tool-dialog';
import { toolErrorKey } from './api';
import { toolDefinitions } from './definitions';

export function AdminToolsPage() {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<{
    tools: ToolConfig[];
    providers: ProviderSummary[];
  }>();
  const [error, setError] = useState<TranslationKey>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<ToolConfig>();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const changing = useRef(new Set<string>());
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.tools.list(undefined, { signal: controller.signal }),
      api.providers.list(undefined, { signal: controller.signal }),
    ]).then(
      ([tools, providers]) => {
        if (!controller.signal.aborted) {
          setData({ tools, providers });
          setLoading(false);
          setError(undefined);
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(toolErrorKey(cause));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [revision]);
  function refresh() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  function saved(tool: ToolConfig) {
    setData((current) =>
      current
        ? {
            ...current,
            tools: current.tools.map((item) =>
              item.id === tool.id ? tool : item,
            ),
          }
        : current,
    );
  }
  async function setEnabled(tool: ToolConfig, enabled: boolean) {
    if (changing.current.has(tool.id)) return;
    changing.current.add(tool.id);
    setPending(new Set(changing.current));
    try {
      saved(
        await api.tools.setEnabled({
          params: { toolId: tool.id },
          body: { enabled },
        }),
      );
      toast.success(t('tools.saved'));
    } catch (cause) {
      toast.error(t(toolErrorKey(cause, tool.id)));
    } finally {
      changing.current.delete(tool.id);
      setPending(new Set(changing.current));
    }
  }
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={t('nav.tools')}
        description={t('tools.description')}
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/providers">{t('tools.manageProviders')}</Link>
          </Button>
        }
      />
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{t('tools.listTitle')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('tools.applyHint')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          disabled={loading || !!selected || pending.size > 0}
          onClick={refresh}
          aria-label={t('tools.refresh')}
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
          <Button
            variant="outline"
            disabled={loading || pending.size > 0}
            onClick={refresh}
          >
            {t('tools.retry')}
          </Button>
        </div>
      ) : null}
      {loading && !data ? (
        <LoadingState />
      ) : data ? (
        <ItemGroup className="rounded-xl border bg-card">
          {data.tools.map((tool) => {
            const definition =
              tool.kind === 'builtin' ? undefined : toolDefinitions[tool.kind];
            const titleKey = `agents.tool.${tool.id}` as Extract<
              TranslationKey,
              `agents.tool.${string}`
            >;
            const title = definition
              ? t(definition.title)
              : i18n.exists(titleKey)
                ? String(t(titleKey))
                : tool.id;
            const provider =
              tool.kind === 'web_search' || tool.kind === 'web_fetch'
                ? data.providers.find(
                    (item) => item.id === tool.config.providerId,
                  )
                : undefined;
            return (
              <Item key={tool.id} role="listitem" className="gap-4 p-5">
                <ItemMedia variant="icon">
                  {tool.kind === 'image_gen' ? (
                    <ImagePlus />
                  ) : tool.kind === 'speech' ? (
                    <AudioLines />
                  ) : tool.kind === 'builtin' ? (
                    <Wrench />
                  ) : (
                    <Globe />
                  )}
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle>
                    {title}
                    <Badge
                      variant={tool.config.enabled ? 'secondary' : 'outline'}
                    >
                      {t(
                        tool.config.enabled
                          ? 'tools.enabled'
                          : 'tools.disabled',
                      )}
                    </Badge>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-2">
                    {definition ? t(definition.description) : tool.description}
                  </ItemDescription>
                  <code className="mt-1 block text-xs text-muted-foreground">
                    {tool.id}
                  </code>
                  {tool.kind === 'image_gen' || tool.kind === 'speech' ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {tool.config.model ??
                        t(
                          tool.kind === 'speech'
                            ? 'tools.defaultSpeechModel'
                            : 'tools.defaultImageModel',
                        )}{' '}
                      ·{' '}
                      {t('tools.imageSummary', {
                        seconds: tool.config.timeoutMs / 1000,
                      })}
                    </p>
                  ) : tool.kind === 'web_search' ||
                    tool.kind === 'web_fetch' ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {provider?.name ??
                        t(
                          tool.config.providerId
                            ? toolDefinitions[tool.kind].missingProvider
                            : toolDefinitions[tool.kind].localLabel,
                        )}{' '}
                      ·{' '}
                      {t(
                        tool.kind === 'web_search'
                          ? 'tools.summary'
                          : 'tools.fetchSummary',
                        {
                          count:
                            tool.kind === 'web_search'
                              ? tool.config.numResults
                              : tool.config.maxChars,
                          seconds: tool.config.timeoutMs / 1000,
                        },
                      )}
                    </p>
                  ) : null}
                </ItemContent>
                <ItemActions className="ml-auto">
                  {definition && (
                    <Button
                      variant="outline"
                      disabled={loading || pending.has(tool.id)}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setSelected(tool);
                      }}
                    >
                      <Settings2 />
                      {t(definition.configure)}
                    </Button>
                  )}
                  <Switch
                    checked={tool.config.enabled}
                    disabled={
                      loading ||
                      pending.has(tool.id) ||
                      selected?.id === tool.id
                    }
                    aria-label={t('tools.toggle', { name: title })}
                    onCheckedChange={(enabled) =>
                      void setEnabled(tool, enabled)
                    }
                  />
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      ) : null}
      {selected?.kind === 'image_gen' || selected?.kind === 'speech' ? (
        <ModelToolDialog
          tool={selected}
          onClose={() => setSelected(undefined)}
          restoreFocus={() => trigger.current?.focus()}
          onSaved={saved}
        />
      ) : selected &&
        (selected.kind === 'web_search' || selected.kind === 'web_fetch') &&
        data ? (
        <WebToolDialog
          tool={selected}
          providers={data.providers}
          onClose={() => setSelected(undefined)}
          restoreFocus={() => trigger.current?.focus()}
          onSaved={saved}
        />
      ) : null}
    </div>
  );
}
