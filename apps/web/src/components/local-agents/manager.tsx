import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  LocalAgentFile,
  LocalAgentList,
  LocalAgentScope,
} from '@aime/shared/agents';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { invalidateAvailableAgents } from '@/features/agents/use-available-agents';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LocalAgentSheet } from './create-sheet';
import { localAgentErrorKey } from './api';

export function LocalAgentsManager({ scope }: { scope: LocalAgentScope }) {
  const kind = scope.scope;
  const projectId = scope.scope === 'project' ? scope.projectId : '';
  const target = useMemo<LocalAgentScope>(
    () => (kind === 'project' ? { scope: kind, projectId } : { scope: kind }),
    [kind, projectId],
  );
  // Remount scope-owned state when navigating directly between projects.
  return <ScopedManager key={`${kind}:${projectId}`} scope={target} />;
}

function ScopedManager({ scope }: { scope: LocalAgentScope }) {
  const { t } = useTranslation();
  const [data, setData] = useState<LocalAgentList>();
  const [error, setError] = useState<TranslationKey>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<'create' | LocalAgentFile>();
  const [changing, setChanging] = useState<string>();
  const [deleting, setDeleting] = useState<LocalAgentFile>();
  const pending = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api.localAgents
      .list({ query: scope }, { signal: controller.signal })
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          setData(result);
          setError(undefined);
          setLoading(false);
        },
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(localAgentErrorKey(cause));
          setLoading(false);
        },
      );
    return () => controller.abort();
  }, [scope, revision]);

  function saved(agent: LocalAgentFile) {
    invalidateAvailableAgents();
    setData(
      (current) =>
        current && {
          ...current,
          agents: current.agents.some(
            (item) => item.filename === agent.filename,
          )
            ? current.agents.map((item) =>
                item.filename === agent.filename ? agent : item,
              )
            : [agent, ...current.agents],
        },
    );
  }
  function refresh() {
    setLoading(true);
    setRevision((current) => current + 1);
  }
  async function toggle(agent: LocalAgentFile, enabled: boolean) {
    if (pending.current) return;
    pending.current = true;
    setChanging(agent.filename);
    try {
      saved(
        await api.localAgents.setEnabled({
          body: {
            target: scope,
            filename: agent.filename,
            version: agent.version,
            enabled,
          },
        }),
      );
      toast.success(
        t(
          enabled
            ? 'localAgents.enabledSuccess'
            : 'localAgents.disabledSuccess',
        ),
      );
    } catch (cause) {
      toast.error(t(localAgentErrorKey(cause)));
    } finally {
      pending.current = false;
      setChanging(undefined);
    }
  }
  async function remove(agent: LocalAgentFile) {
    if (pending.current) return;
    pending.current = true;
    setChanging(agent.filename);
    try {
      await api.localAgents.remove({
        body: {
          target: scope,
          filename: agent.filename,
          version: agent.version,
        },
      });
      setData(
        (current) =>
          current && {
            ...current,
            agents: current.agents.filter(
              (item) => item.filename !== agent.filename,
            ),
          },
      );
      setDeleting(undefined);
      invalidateAvailableAgents();
      toast.success(t('localAgents.deleted', { name: agent.displayName }));
    } catch (cause) {
      toast.error(t(localAgentErrorKey(cause)));
    } finally {
      pending.current = false;
      setChanging(undefined);
    }
  }
  function restoreFocus() {
    (trigger.current?.isConnected
      ? trigger.current
      : (searchInput.current ?? createButton.current)
    )?.focus();
  }
  const search = query.trim().toLowerCase();
  const visible =
    data?.agents.filter((agent) =>
      `${agent.name} ${agent.displayName} ${agent.description} ${agent.filename}`
        .toLowerCase()
        .includes(search),
    ) ?? [];
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={t(`localAgents.title.${scope.scope}`)}
        description={t(`localAgents.hint.${scope.scope}`)}
        actions={
          data?.canManage && (
            <Button
              ref={createButton}
              disabled={loading || !!error || !!changing}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setAction('create');
              }}
            >
              <Plus />
              {t('localAgents.create')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            ref={searchInput}
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('agents.search')}
            aria-label={t('agents.search')}
          />
        </div>
        <Badge variant="secondary">
          {t('agents.count', { count: data?.agents.length ?? 0 })}
        </Badge>
        {data && !data.canManage && (
          <Badge variant="outline">{t('localAgents.readOnly')}</Badge>
        )}
        <Button
          className="ml-auto"
          variant="outline"
          size="icon"
          aria-label={t('agents.refresh')}
          disabled={loading || !!action || !!changing || !!deleting}
          onClick={refresh}
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/25 p-4 text-sm text-destructive"
        >
          <span>{t(error)}</span>
          <Button variant="outline" disabled={loading} onClick={refresh}>
            {t('agents.retry')}
          </Button>
        </div>
      )}
      {loading && !data ? (
        <LoadingState />
      ) : (
        data && (
          <section
            className="overflow-hidden rounded-xl border bg-card"
            aria-label={t('localAgents.list')}
          >
            <ScrollArea
              className="h-[min(60dvh,42rem)]"
              viewportProps={{
                'aria-busy': loading,
                className: '[&>div]:block!',
              }}
            >
              {visible.length ? (
                <div className="divide-y">
                  {visible.map((agent) => (
                    <article
                      key={agent.filename}
                      className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start"
                    >
                      <div className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary sm:flex">
                        <Bot className="size-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="break-all text-sm font-semibold">
                            {agent.displayName}
                          </h2>
                          <Badge
                            variant={agent.enabled ? 'default' : 'secondary'}
                          >
                            {t(
                              agent.enabled
                                ? 'localAgents.enabled'
                                : 'localAgents.disabled',
                            )}
                          </Badge>
                          <Badge variant="outline">Markdown</Badge>
                        </div>
                        <p className="mt-2 line-clamp-3 break-words text-sm leading-6 text-muted-foreground">
                          {agent.description}
                        </p>
                        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                          {agent.filename}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center justify-end gap-3">
                        {data.canManage && (
                          <Switch
                            checked={agent.enabled}
                            disabled={
                              loading ||
                              !!error ||
                              !!changing ||
                              !!action ||
                              !!deleting
                            }
                            aria-label={t('localAgents.toggle', {
                              name: agent.displayName,
                            })}
                            aria-busy={changing === agent.filename}
                            onCheckedChange={(value) =>
                              void toggle(agent, value)
                            }
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={loading || !!error || !!changing}
                          aria-label={t(
                            data.canManage
                              ? 'localAgents.editNamed'
                              : 'agents.viewNamed',
                            {
                              name: agent.displayName,
                            },
                          )}
                          onClick={(event) => {
                            trigger.current = event.currentTarget;
                            setAction(agent);
                          }}
                        >
                          {data.canManage ? <Pencil /> : <Eye />}
                        </Button>
                        {data.canManage && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:text-destructive"
                            disabled={loading || !!error || !!changing}
                            aria-label={t('localAgents.deleteNamed', {
                              name: agent.displayName,
                            })}
                            onClick={(event) => {
                              trigger.current = event.currentTarget;
                              setDeleting(agent);
                            }}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="px-6 py-20 text-center">
                  <Bot className="mx-auto mb-4 size-8 text-muted-foreground" />
                  <h2 className="text-sm font-medium">
                    {t(search ? 'agents.noMatches' : 'localAgents.empty')}
                  </h2>
                  <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                    {t(
                      search
                        ? 'agents.searchHint'
                        : data.canManage
                          ? 'localAgents.emptyHint'
                          : 'localAgents.readOnlyHint',
                    )}
                  </p>
                </div>
              )}
            </ScrollArea>
          </section>
        )
      )}
      {action && (
        <LocalAgentSheet
          scope={scope}
          agent={action === 'create' ? undefined : action}
          readOnly={!data?.canManage}
          onClose={() => setAction(undefined)}
          onSaved={saved}
          restoreFocus={restoreFocus}
        />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !pending.current) setDeleting(undefined);
        }}
      >
        <DialogContent
          showCloseButton={!changing}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t('localAgents.deleteNamed', {
                name: deleting?.displayName ?? '',
              })}
            </DialogTitle>
            <DialogDescription>{t('localAgents.deleteHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-lg border p-3">
            <Badge variant="secondary">
              {t(`localAgents.scope.${scope.scope}`)}
            </Badge>
            <p className="break-all font-mono text-sm">{deleting?.filename}</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={!!changing}
              onClick={() => setDeleting(undefined)}
            >
              {t('agents.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={!!changing}
              onClick={() => {
                if (deleting) void remove(deleting);
              }}
            >
              {t(changing ? 'localAgents.deleting' : 'agents.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
