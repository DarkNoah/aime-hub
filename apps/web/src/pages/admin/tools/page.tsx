import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Globe, Settings2, RefreshCw } from 'lucide-react';
import type { ToolConfig } from '@aime/shared/tools';
import type { ProviderSummary } from '@aime/shared/providers';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { toolErrorKey } from './api';
import { toolDefinitions } from './definitions';

export function AdminToolsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<{
    tools: ToolConfig[];
    providers: ProviderSummary[];
  }>();
  const [error, setError] = useState<TranslationKey>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<ToolConfig>();
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
        <h2 className="text-sm font-medium">{t('tools.listTitle')}</h2>
        <Button
          variant="ghost"
          size="icon"
          disabled={loading || !!selected}
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
          <Button variant="outline" disabled={loading} onClick={refresh}>
            {t('tools.retry')}
          </Button>
        </div>
      ) : null}
      {loading && !data ? (
        <LoadingState />
      ) : data ? (
        <ItemGroup className="rounded-xl border bg-card">
          {data.tools.map((tool) => {
            const definition = toolDefinitions[tool.id];
            const provider = data.providers.find(
              (item) => item.id === tool.config.providerId,
            );
            return (
              <Item key={tool.id} role="listitem" className="gap-4 p-5">
                <ItemMedia variant="icon">
                  <Globe />
                </ItemMedia>
                <ItemContent className="min-w-48">
                  <ItemTitle>
                    {t(definition.title)}
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
                  <ItemDescription>{t(definition.description)}</ItemDescription>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {provider?.name ??
                      t(
                        tool.config.providerId
                          ? definition.missingProvider
                          : definition.localLabel,
                      )}{' '}
                    ·{' '}
                    {t(
                      tool.id === 'web_search'
                        ? 'tools.summary'
                        : 'tools.fetchSummary',
                      {
                        count:
                          tool.id === 'web_search'
                            ? tool.config.numResults
                            : tool.config.maxChars,
                        seconds: tool.config.timeoutMs / 1000,
                      },
                    )}
                  </p>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    disabled={loading}
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      setSelected(tool);
                    }}
                  >
                    <Settings2 />
                    {t(definition.configure)}
                  </Button>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      ) : null}
      {selected && data ? (
        <WebToolDialog
          tool={selected}
          providers={data.providers}
          onClose={() => setSelected(undefined)}
          restoreFocus={() => trigger.current?.focus()}
          onSaved={(tool) =>
            setData((current) =>
              current
                ? {
                    ...current,
                    tools: current.tools.map((item) =>
                      item.id === tool.id ? tool : item,
                    ),
                  }
                : current,
            )
          }
        />
      ) : null}
    </div>
  );
}
