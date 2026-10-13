import { useEffect, useRef, useState } from 'react';
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
import type { AdminAgent, CodeAgent, ManagedAgent } from '@aime/shared/agents';
import { AgentSelector } from '@/components/agent-selector';
import { invalidateAvailableAgents } from '@/features/agents/use-available-agents';
import { CodeAgentSheet } from './components/code-agent-sheet';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { AgentSheet } from './components/agent-sheet';
import { DeleteAgentDialog } from './components/delete-dialog';
import { agentErrorKey } from './api';

type Action =
  | { kind: 'create' }
  | { kind: 'view'; agent: CodeAgent }
  | { kind: 'edit' | 'delete'; agent: ManagedAgent };

export function AdminAgentsPage() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AdminAgent[]>();
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const [changingStatus, setChangingStatus] = useState<string | null>(null);
  const statusPending = useRef(false);
  const [error, setError] = useState<TranslationKey>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState<Action>();
  const trigger = useRef<HTMLElement | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.agents.list(undefined, { signal: controller.signal }),
      api.agents.defaults(undefined, { signal: controller.signal }),
    ]).then(
      ([data, defaults]) => {
        if (controller.signal.aborted) return;
        setAgents(data);
        setDefaultAgentId(defaults.defaultAgentId);
        setError(undefined);
        setLoading(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(agentErrorKey(cause));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [revision]);
  function open(next: Action, element: HTMLElement) {
    trigger.current = element;
    setAction(next);
  }
  function restoreFocus() {
    (trigger.current?.isConnected
      ? trigger.current
      : createButton.current
    )?.focus();
  }
  function saved(agent: ManagedAgent) {
    invalidateAvailableAgents();
    setAgents((current = []) =>
      current.some((item) => item.id === agent.id)
        ? current.map((item) => (item.id === agent.id ? agent : item))
        : [agent, ...current],
    );
  }
  function refresh() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  async function changeStatus(agent: ManagedAgent, published: boolean) {
    if (statusPending.current) return;
    statusPending.current = true;
    setChangingStatus(agent.id);
    try {
      const updated = await api.agents.setStatus({
        params: { id: agent.id },
        body: {
          status: published ? 'published' : 'draft',
          versionId: agent.versionId,
        },
      });
      saved(updated);
      toast.success(t(published ? 'agents.published' : 'agents.unpublished'));
    } catch (cause) {
      toast.error(t(agentErrorKey(cause)));
    } finally {
      statusPending.current = false;
      setChangingStatus(null);
    }
  }
  const query = search.trim().toLowerCase();
  const visible =
    agents?.filter((agent) =>
      `${agent.name} ${agent.description}`.toLowerCase().includes(query),
    ) ?? [];
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={t('nav.agents')}
        description={t('admin.agentsDescription')}
        actions={
          <Button
            ref={createButton}
            disabled={loading || !!error}
            onClick={(event) => open({ kind: 'create' }, event.currentTarget)}
          >
            <Plus />
            {t('agents.create')}
          </Button>
        }
      />
      <p className="rounded-lg border bg-muted/30 px-4 py-3 text-sm leading-6 text-muted-foreground">
        {t('agents.scopeHint')}
      </p>
      <section className="space-y-2 rounded-xl border bg-card p-4">
        <label htmlFor="default-agent" className="text-sm font-medium">
          {t('agents.default')}
        </label>
        <div className="max-w-sm">
          <AgentSelector
            id="default-agent"
            label={t('agents.default')}
            value={defaultAgentId}
            allowDefault={false}
            agents={
              agents?.filter(
                (agent) =>
                  agent.source === 'code' || agent.status === 'published',
              ) ?? []
            }
            disabled={loading || !!error || savingDefault || !!changingStatus}
            onValueChange={(id) => {
              if (!id || id === defaultAgentId) return;
              setSavingDefault(true);
              void api.agents
                .saveDefaults({ body: { defaultAgentId: id } })
                .then((value) => {
                  setDefaultAgentId(value.defaultAgentId);
                  invalidateAvailableAgents();
                  toast.success(t('agents.defaultSaved'));
                })
                .catch((cause) => toast.error(t(agentErrorKey(cause))))
                .finally(() => setSavingDefault(false));
            }}
          />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {t('agents.defaultHint')}
        </p>
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('agents.search')}
            aria-label={t('agents.search')}
          />
        </div>
        <Badge variant="secondary">
          {t('agents.count', { count: agents?.length ?? 0 })}
        </Badge>
        <Button
          className="ml-auto"
          variant="outline"
          size="icon"
          disabled={loading || !!action || !!changingStatus}
          onClick={refresh}
          aria-label={t('agents.refresh')}
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
            {t('agents.retry')}
          </Button>
        </div>
      ) : null}
      {loading && !agents ? (
        <LoadingState />
      ) : agents ? (
        <section
          className="overflow-hidden rounded-xl border bg-card"
          aria-label={t('nav.agents')}
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
                    key={agent.id}
                    className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:gap-5"
                  >
                    <div className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary sm:flex">
                      <Bot className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="break-all text-sm font-semibold">
                          {agent.name}
                        </h2>
                        <Badge
                          variant={
                            agent.source === 'database' &&
                            agent.status === 'published'
                              ? 'default'
                              : 'secondary'
                          }
                        >
                          {agent.source === 'code'
                            ? t('agents.code')
                            : t(`agents.status.${agent.status}`)}
                        </Badge>
                        {agent.id === defaultAgentId && (
                          <Badge>{t('agents.default')}</Badge>
                        )}
                        {agent.source === 'database' && (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            v{agent.versionNumber}
                          </span>
                        )}
                      </div>
                      {agent.description ? (
                        <p className="mt-2 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">
                          {agent.description}
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge variant="outline">
                          {agent.disabledTools.length
                            ? t('agents.toolsExcluded', {
                                count: agent.disabledTools.length,
                              })
                            : t('agents.toolsManaged')}
                        </Badge>
                        <Badge variant="outline">
                          {agent.source === 'code' ||
                          agent.skillsMode === 'auto'
                            ? t('agents.skillsAutoSummary')
                            : t('agents.skillsCount', {
                                count: agent.skillPaths.length,
                              })}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center justify-end gap-1">
                      {agent.source === 'database' && (
                        <label
                          className="mr-3 flex items-center gap-2 text-xs text-muted-foreground"
                          title={
                            agent.id === defaultAgentId
                              ? t('agents.isDefault')
                              : undefined
                          }
                        >
                          {t('agents.publish')}
                          <Switch
                            checked={agent.status === 'published'}
                            disabled={
                              loading ||
                              savingDefault ||
                              !!changingStatus ||
                              !!action ||
                              agent.id === defaultAgentId
                            }
                            aria-label={t('agents.publishNamed', {
                              name: agent.name,
                            })}
                            aria-busy={changingStatus === agent.id}
                            onCheckedChange={(checked) =>
                              void changeStatus(agent, checked)
                            }
                          />
                        </label>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={loading || changingStatus === agent.id}
                        aria-label={t(
                          agent.source === 'code'
                            ? 'agents.viewNamed'
                            : 'agents.editNamed',
                          { name: agent.name },
                        )}
                        onClick={(event) =>
                          open(
                            agent.source === 'code'
                              ? { kind: 'view', agent }
                              : { kind: 'edit', agent },
                            event.currentTarget,
                          )
                        }
                      >
                        {agent.source === 'code' ? <Eye /> : <Pencil />}
                      </Button>
                      {agent.source === 'database' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={
                            loading ||
                            savingDefault ||
                            changingStatus === agent.id ||
                            agent.id === defaultAgentId
                          }
                          aria-label={t('agents.deleteNamed', {
                            name: agent.name,
                          })}
                          onClick={(event) =>
                            open({ kind: 'delete', agent }, event.currentTarget)
                          }
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
                  {t(query ? 'agents.noMatches' : 'agents.empty')}
                </h2>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                  {t(query ? 'agents.searchHint' : 'agents.emptyHint')}
                </p>
              </div>
            )}
          </ScrollArea>
        </section>
      ) : null}
      {action?.kind === 'view' ? (
        <CodeAgentSheet
          agent={action.agent}
          onClose={() => setAction(undefined)}
          restoreFocus={restoreFocus}
        />
      ) : action?.kind === 'delete' ? (
        <DeleteAgentDialog
          agent={action.agent}
          onClose={() => setAction(undefined)}
          restoreFocus={restoreFocus}
          onRemoved={(id) => {
            setAgents((current) => current?.filter((agent) => agent.id !== id));
            invalidateAvailableAgents();
          }}
        />
      ) : action ? (
        <AgentSheet
          agent={action.kind === 'edit' ? action.agent : undefined}
          onClose={() => setAction(undefined)}
          onSaved={saved}
          restoreFocus={restoreFocus}
        />
      ) : null}
    </div>
  );
}
