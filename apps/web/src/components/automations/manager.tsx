import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import {
  Clock3,
  History,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  Automation,
  AutomationList,
  AutomationScope,
} from '@aime/shared/automations';
import { api } from '@/lib/rpc';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from '@/components/ui/item';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AutomationEditor } from './editor';
import { AutomationHistory } from './history';
import { automationErrorKey } from './errors';
import { BrowserPushEnrollment } from './desktop-notification-switch';

export function AutomationManager({
  scope,
  projectName,
}: {
  scope: AutomationScope;
  projectName?: string;
}) {
  const { t, i18n } = useTranslation();
  const scopeKey =
    scope.scope === 'project' ? `project:${scope.projectId}` : scope.scope;
  return (
    <ManagerSession
      key={scopeKey}
      scope={scope}
      title={
        projectName
          ? `${projectName} · ${t('automations.title')}`
          : t(`automations.title.${scope.scope}`)
      }
      locale={i18n.language}
    />
  );
}

function ManagerSession({
  scope,
  title,
  locale,
}: {
  scope: AutomationScope;
  title: string;
  locale: string;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<AutomationList>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<
    | { kind: 'edit' | 'history' | 'delete'; task: Automation }
    | { kind: 'create' }
  >();
  const [busy, setBusy] = useState<string[]>([]);
  const pending = useRef(new Set<string>());
  const trigger = useRef<HTMLElement | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = () =>
    (trigger.current?.isConnected
      ? trigger.current
      : createButton.current
    )?.focus();
  const scopeType = scope.scope;
  const projectId = scope.scope === 'project' ? scope.projectId : undefined;
  useEffect(() => {
    const controller = new AbortController();
    const target: AutomationScope =
      scopeType === 'project'
        ? { scope: scopeType, projectId: projectId! }
        : { scope: scopeType };
    void api.automations.list(target, { signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setError('');
          setLoading(false);
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(t(automationErrorKey(cause)));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [scopeType, projectId, revision, t]);
  function saved(task: Automation) {
    setData((current) =>
      current
        ? {
            ...current,
            items: current.items.some((item) => item.id === task.id)
              ? current.items.map((item) => (item.id === task.id ? task : item))
              : [task, ...current.items],
          }
        : current,
    );
  }
  async function mutate(
    task: Automation,
    operation: 'toggle' | 'run' | 'delete',
  ) {
    if (pending.current.has(task.id)) return;
    pending.current.add(task.id);
    setBusy([...pending.current]);
    try {
      if (operation === 'toggle') {
        saved(
          await api.automations.setEnabled({
            id: task.id,
            enabled: !task.enabled,
          }),
        );
        toast.success(
          t(
            task.enabled
              ? 'automations.pausedToast'
              : 'automations.enabledToast',
          ),
        );
      } else if (operation === 'run') {
        const started = await api.automations.run({ id: task.id });
        saved(started);
        toast.success(t('automations.queued'));
        setAction({ kind: 'history', task: started });
      } else {
        await api.automations.remove({ id: task.id });
        setData((current) =>
          current
            ? {
                ...current,
                items: current.items.filter((item) => item.id !== task.id),
              }
            : current,
        );
        setAction(undefined);
        toast.success(t('automations.deleted'));
      }
    } catch (cause) {
      toast.error(t(automationErrorKey(cause)));
    } finally {
      pending.current.delete(task.id);
      setBusy([...pending.current]);
    }
  }
  const visible =
    data?.items.filter((item) =>
      `${item.name} ${item.prompt}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    ) ?? [];
  const formatTime = (value: string | null, timezone: string) =>
    value
      ? new Date(value).toLocaleString(locale, {
          timeZone: timezone,
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : t('automations.noNextRun');
  return (
    <div
      className="min-w-0 space-y-6"
      onClickCapture={(event) => {
        if (!action && event.target instanceof HTMLElement) {
          const button = event.target.closest('button');
          if (button) trigger.current = button;
        }
      }}
    >
      <PageHeader
        title={title}
        description={t(`automations.description.${scope.scope}`)}
        actions={
          data?.canManage && (
            <Button
              ref={createButton}
              onClick={() => setAction({ kind: 'create' })}
              disabled={loading}
            >
              <Plus />
              {t('automations.create')}
            </Button>
          )
        }
      />
      {data?.items.some((task) => task.desktopNotification) && (
        <BrowserPushEnrollment />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-40 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('automations.search')}
            aria-label={t('automations.search')}
            className="pl-9"
          />
        </div>
        <Badge variant="secondary">
          {t('automations.count', { count: data?.items.length ?? 0 })}
        </Badge>
        <Button
          variant="outline"
          size="icon"
          className="ml-auto"
          disabled={loading || busy.length > 0 || !!action}
          aria-label={t('automations.refresh')}
          onClick={() => {
            setLoading(true);
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
        </Button>
      </div>
      {data && !data.canManage && (
        <p className="text-sm text-muted-foreground">
          {t('automations.readOnly')}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/25 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {loading && !data ? (
        <LoadingState />
      ) : (
        data && (
          <ScrollArea
            className="rounded-xl border bg-card"
            viewportProps={{
              className: 'max-h-[68dvh] [&>div]:block!',
              'aria-busy': loading,
            }}
          >
            <ItemGroup className="divide-y">
              {visible.map((task) => (
                <Item
                  key={task.id}
                  role="listitem"
                  className="flex-col items-stretch gap-4 rounded-none p-5 lg:flex-row lg:items-center"
                >
                  <ItemContent className="min-w-0 flex-1">
                    <ItemTitle className="w-full">
                      <span className="min-w-0 truncate font-semibold">
                        {task.name}
                      </span>
                      <Badge
                        variant={task.enabled ? 'secondary' : 'outline'}
                        className="shrink-0"
                      >
                        {t(
                          task.enabled
                            ? 'automations.enabled'
                            : 'automations.paused',
                        )}
                      </Badge>
                    </ItemTitle>
                    <ItemDescription className="line-clamp-2 break-words">
                      {task.prompt}
                    </ItemDescription>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock3 className="size-3.5" aria-hidden="true" />
                        {t('automations.nextRun', {
                          time: formatTime(task.nextFireAt, task.timezone),
                        })}
                      </span>
                      <span>{task.timezone}</span>
                      <code>{task.cron}</code>
                    </div>
                  </ItemContent>
                  <div className="flex shrink-0 flex-wrap items-center gap-1 self-end lg:self-auto">
                    {task.separateThread && task.threadCreated && (
                      <Button asChild variant="ghost" size="icon-sm">
                        <Link
                          to={
                            task.scope.scope === 'project'
                              ? '/projects/$projectId/threads/$threadId'
                              : '/threads/$threadId'
                          }
                          params={{
                            threadId: task.threadId,
                            ...(task.scope.scope === 'project'
                              ? { projectId: task.scope.projectId }
                              : {}),
                          }}
                          aria-label={t('automations.openThread')}
                        >
                          <MessageSquare />
                        </Link>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('automations.historyNamed', {
                        name: task.name,
                      })}
                      onClick={() => setAction({ kind: 'history', task })}
                    >
                      <History />
                    </Button>
                    {data.canManage && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('automations.runNamed', {
                            name: task.name,
                          })}
                          disabled={busy.includes(task.id) || loading}
                          onClick={() => void mutate(task, 'run')}
                        >
                          <Play />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('automations.editNamed', {
                            name: task.name,
                          })}
                          disabled={busy.includes(task.id) || loading}
                          onClick={() => setAction({ kind: 'edit', task })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={t('automations.deleteNamed', {
                            name: task.name,
                          })}
                          disabled={busy.includes(task.id) || loading}
                          onClick={() => setAction({ kind: 'delete', task })}
                        >
                          <Trash2 />
                        </Button>
                        <Switch
                          className="ml-3"
                          checked={task.enabled}
                          disabled={busy.includes(task.id) || loading}
                          aria-label={t('automations.enableNamed', {
                            name: task.name,
                          })}
                          onCheckedChange={() => void mutate(task, 'toggle')}
                        />
                      </>
                    )}
                  </div>
                </Item>
              ))}
            </ItemGroup>
            {!visible.length && (
              <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                <Clock3
                  className="size-8 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="font-medium">
                  {t(query ? 'automations.noMatches' : 'automations.empty')}
                </p>
                <p className="max-w-md text-sm text-muted-foreground">
                  {t(
                    query ? 'automations.searchHint' : 'automations.emptyHint',
                  )}
                </p>
              </div>
            )}
          </ScrollArea>
        )
      )}
      {(action?.kind === 'create' || action?.kind === 'edit') && (
        <AutomationEditor
          scope={scope}
          task={action.kind === 'edit' ? action.task : undefined}
          onClose={() => setAction(undefined)}
          onSaved={saved}
          restoreFocus={restoreFocus}
        />
      )}
      {action?.kind === 'history' && (
        <AutomationHistory
          task={action.task}
          onClose={() => setAction(undefined)}
          restoreFocus={restoreFocus}
        />
      )}
      {action?.kind === 'delete' && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy.includes(action.task.id)) setAction(undefined);
          }}
        >
          <DialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              restoreFocus();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {t('automations.deleteTitle', { name: action.task.name })}
              </DialogTitle>
              <DialogDescription>
                {t('automations.deleteHint')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy.includes(action.task.id)}
                onClick={() => setAction(undefined)}
              >
                {t('providers.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={busy.includes(action.task.id)}
                onClick={() => void mutate(action.task, 'delete')}
              >
                {t('automations.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
