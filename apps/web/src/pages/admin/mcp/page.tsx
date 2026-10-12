import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Globe,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import type { McpServer } from '@aime/shared/mcp';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { mcpErrorKey } from './api';
import { McpDialog, type McpAction } from './components/mcp-dialog';
import { McpToolsSheet } from './components/tools-sheet';

function endpoint(server: McpServer) {
  if (server.config.command) return server.config.command;
  try {
    const url = new URL(server.config.url!);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

export function AdminMcpPage() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServer[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState<McpAction>();
  const [toolsServer, setToolsServer] = useState<McpServer>();
  const [pending, setPending] = useState<string>();
  const submitting = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.mcp.list(undefined, { signal: controller.signal }).then(
      (data) => {
        if (controller.signal.aborted) return;
        setServers(data);
        setError(undefined);
        setLoading(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(mcpErrorKey(cause));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [revision]);

  function saved(items: McpServer[]) {
    setServers((current = []) => {
      const next = new Map(current.map((item) => [item.id, item]));
      items.forEach((item) => next.set(item.id, item));
      return [...next.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
  }
  function open(next: McpAction, element: HTMLElement) {
    trigger.current = element;
    setAction(next);
  }
  function refresh() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  async function publish(server: McpServer, published: boolean) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(server.id);
    try {
      saved([
        await api.mcp.status({
          params: { id: server.id },
          body: {
            revision: server.revision,
            status: published ? 'published' : 'draft',
          },
        }),
      ]);
      toast.success(t(published ? 'mcp.published' : 'mcp.unpublished'));
    } catch (cause) {
      toast.error(t(mcpErrorKey(cause)));
    } finally {
      submitting.current = false;
      setPending(undefined);
    }
  }
  async function testConnection(server: McpServer) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(server.id);
    try {
      const result = await api.mcp.test({ params: { id: server.id } });
      toast.success(t('mcp.testSuccess', { count: result.toolCount }));
    } catch (cause) {
      toast.error(t(mcpErrorKey(cause)));
    } finally {
      submitting.current = false;
      setPending(undefined);
    }
  }
  const query = search.trim().toLowerCase();
  const visible =
    servers?.filter((server) =>
      `${server.name} ${endpoint(server)}`.toLowerCase().includes(query),
    ) ?? [];
  const busy = !!pending || !!action || !!toolsServer || loading;

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={t('nav.mcp')}
        description={t('mcp.description')}
        actions={
          <Button
            ref={createButton}
            disabled={busy || !!error}
            onClick={(event) => open({ kind: 'create' }, event.currentTarget)}
          >
            <Plus />
            {t('mcp.create')}
          </Button>
        }
      />
      <section
        className="overflow-hidden rounded-xl border bg-card"
        aria-labelledby="mcp-list-title"
      >
        <div className="flex flex-wrap items-center gap-3 border-b p-4 sm:p-5">
          <h2 id="mcp-list-title" className="text-sm font-semibold">
            {t('mcp.listTitle')}
          </h2>
          <Badge variant="secondary">{servers?.length ?? 0}</Badge>
          <div className="relative order-3 w-full sm:order-none sm:ml-auto sm:w-64">
            <Search
              className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              placeholder={t('mcp.search')}
              aria-label={t('mcp.search')}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            onClick={refresh}
            className="ml-auto sm:ml-0"
            aria-label={t('mcp.refresh')}
          >
            <RefreshCw
              className={
                loading ? 'animate-spin motion-reduce:animate-none' : undefined
              }
            />
          </Button>
        </div>
        {error ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 p-5 text-sm text-destructive"
          >
            <span>{t(error)}</span>
            <Button variant="outline" disabled={busy} onClick={refresh}>
              {t('mcp.retry')}
            </Button>
          </div>
        ) : null}
        {loading && !servers ? (
          <div
            className="space-y-4 p-5"
            role="status"
            aria-label={t('mcp.loading')}
          >
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-20 w-full" />
            ))}
          </div>
        ) : servers ? (
          <ScrollArea
            className="h-[min(65dvh,42rem)]"
            viewportProps={{ 'aria-busy': loading }}
          >
            {visible.length ? (
              <ul className="divide-y">
                {visible.map((server) => (
                  <li
                    key={server.id}
                    className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5"
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <div
                        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                        aria-hidden="true"
                      >
                        {server.config.command ? (
                          <Terminal className="size-5" />
                        ) : (
                          <Globe className="size-5" />
                        )}
                      </div>
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="break-all text-sm font-medium">
                            {server.name}
                          </span>
                          <Badge variant="outline">
                            {server.config.command
                              ? 'Stdio'
                              : 'Streamable HTTP / SSE'}
                          </Badge>
                          <Badge
                            variant={
                              server.status === 'published'
                                ? 'default'
                                : 'secondary'
                            }
                          >
                            {t(`mcp.status.${server.status}`)}
                          </Badge>
                        </div>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {endpoint(server)}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || server.status !== 'published'}
                        aria-label={t('mcp.toolsNamed', { name: server.name })}
                        onClick={(event) => {
                          trigger.current = event.currentTarget;
                          setToolsServer(server);
                        }}
                      >
                        <Wrench />
                        {t('mcp.tools')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy || server.status !== 'published'}
                        aria-label={t('mcp.testNamed', { name: server.name })}
                        onClick={() => void testConnection(server)}
                      >
                        <Plug
                          className={
                            pending === server.id
                              ? 'animate-pulse motion-reduce:animate-none'
                              : undefined
                          }
                        />
                      </Button>
                      <Switch
                        checked={server.status === 'published'}
                        disabled={busy}
                        aria-label={t('mcp.publishNamed', {
                          name: server.name,
                        })}
                        onCheckedChange={(checked) =>
                          void publish(server, checked)
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={t('mcp.editNamed', { name: server.name })}
                        onClick={(event) =>
                          open({ kind: 'edit', server }, event.currentTarget)
                        }
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={t('mcp.deleteNamed', { name: server.name })}
                        onClick={(event) =>
                          open({ kind: 'delete', server }, event.currentTarget)
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                <Plug
                  className="size-7 text-muted-foreground"
                  aria-hidden="true"
                />
                <h3 className="text-sm font-medium">
                  {t(query ? 'mcp.noMatches' : 'mcp.empty')}
                </h3>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {t(query ? 'mcp.searchHint' : 'mcp.emptyHint')}
                </p>
                {!query ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={(event) =>
                      open({ kind: 'create' }, event.currentTarget)
                    }
                  >
                    <Plus />
                    {t('mcp.create')}
                  </Button>
                ) : null}
              </div>
            )}
          </ScrollArea>
        ) : null}
      </section>
      {toolsServer ? (
        <McpToolsSheet
          key={toolsServer.id}
          server={toolsServer}
          onClose={() => setToolsServer(undefined)}
          restoreFocus={() => trigger.current?.focus()}
        />
      ) : null}
      {action ? (
        <McpDialog
          action={action}
          onClose={() => setAction(undefined)}
          onSaved={saved}
          onRemoved={(id) =>
            setServers((current) =>
              current?.filter((server) => server.id !== id),
            )
          }
          restoreFocus={() => {
            (trigger.current?.isConnected
              ? trigger.current
              : createButton.current
            )?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
