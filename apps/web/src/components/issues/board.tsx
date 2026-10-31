import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import { issueStates, type Issue, type IssueState } from '@aime/shared/issues';
import type { ChatSettings } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePersonalChatSettings } from '@/components/chat/use-personal-chat-settings';
import { cn } from '@/lib/utils';
import { useIssues } from './use-issues';
import { IssueStateBadge } from './presentation';
import { IssueBoardToolbar } from './board-toolbar';
import { IssueCard } from './card';
import { IssueFormDialog } from './form-dialog';
import { IssueDetailSheet } from './detail-sheet';
import { issueApi } from './api';

const columnStyles = {
  decision: {
    background: 'bg-muted/40',
    badge: 'border-transparent bg-background text-muted-foreground',
    icon: CircleDashed,
  },
  todo: {
    background: 'bg-muted/40',
    badge: 'border-transparent bg-background text-muted-foreground',
    icon: Circle,
  },
  in_progress: {
    background: 'bg-amber-50/60 dark:bg-amber-950/20',
    badge: 'border-transparent bg-amber-500 text-black dark:bg-amber-400',
    icon: CircleDot,
  },
  done: {
    background: 'bg-blue-50/70 dark:bg-blue-950/20',
    badge: 'border-transparent bg-blue-600 text-white dark:bg-blue-500',
    icon: CheckCircle2,
  },
} as const;

export function IssueBoard(props: {
  projectId?: string;
  settings?: ChatSettings;
  compact?: boolean;
  threadId?: string;
  onClose?: () => void;
}) {
  // Scope changes discard only the old scope's data, never an edited row's scroll position.
  return <ScopedIssueBoard key={props.projectId ?? 'personal'} {...props} />;
}

function ScopedIssueBoard({
  projectId,
  settings,
  compact = false,
  threadId,
  onClose,
}: {
  projectId?: string;
  settings?: ChatSettings;
  compact?: boolean;
  threadId?: string;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const personal = usePersonalChatSettings(projectId);
  const { board, loading, error, more, loadMore, refresh } = useIssues(
    projectId,
    compact,
  );
  const [creating, setCreating] = useState<IssueState | null>(null);
  const [visibleStates, setVisibleStates] = useState<IssueState[]>([
    ...issueStates,
  ]);
  const [showDescription, setShowDescription] = useState(true);
  const [showUpdatedAt, setShowUpdatedAt] = useState(true);
  const [selected, setSelected] = useState<Issue | null>(null);
  const [current, setCurrent] = useState<Issue | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (threadId)
      void issueApi
        .forThread({ threadId, projectId }, { signal: controller.signal })
        .then((issue) => {
          if (!controller.signal.aborted) setCurrent(issue);
        })
        .catch(() => {
          if (!controller.signal.aborted) setCurrent(null);
        });
    return () => controller.abort();
  }, [threadId, projectId, board]);
  const states = issueStates.filter((state) => visibleStates.includes(state));
  const count = states.reduce((total, state) => total + board[state].count, 0);
  const columns = (
    <ScrollArea
      className={cn(
        'min-w-0',
        compact ? 'min-h-0 flex-1' : 'h-[min(36rem,70dvh)] min-h-80',
      )}
      viewportProps={{ className: '[&>div]:!block [&>div]:h-full' }}
    >
      <div className="flex h-full gap-3 pb-3">
        {states.map((state) => {
          const column = board[state];
          const style = columnStyles[state];
          const Icon = style.icon;
          return (
            <section
              key={state}
              aria-label={t(`issues.state.${state}`)}
              className={cn(
                'flex min-h-0 min-w-60 flex-1 flex-col rounded-xl',
                style.background,
              )}
            >
              <header className="flex shrink-0 items-center gap-2 px-3 py-2.5">
                <Badge
                  variant="outline"
                  className={cn(
                    'gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
                    style.badge,
                  )}
                >
                  <Icon className="size-3" aria-hidden />
                  {t(`issues.state.${state}`)}
                </Badge>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {column.count}
                </span>
                <div className="ml-auto flex items-center gap-0.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground"
                        aria-label={t('issues.columnActions', {
                          state: t(`issues.state.${state}`),
                        })}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => setVisibleStates([state])}
                      >
                        {t('issues.onlyState')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          setVisibleStates((current) =>
                            current.filter((item) => item !== state),
                          )
                        }
                      >
                        {t('issues.hideState')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    aria-label={t('issues.createIn', {
                      state: t(`issues.state.${state}`),
                    })}
                    onClick={() => setCreating(state)}
                  >
                    <Plus />
                  </Button>
                </div>
              </header>
              <ScrollArea
                className="min-h-0 flex-1"
                viewportProps={{ className: '[&>div]:!block' }}
              >
                <div className="px-2 pb-2">
                  {loading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-28 w-full rounded-lg" />
                      <Skeleton className="h-24 w-full rounded-lg" />
                    </div>
                  ) : (
                    <>
                      <ul className="space-y-2">
                        {column.items.map((issue) => (
                          <IssueCard
                            key={issue.id}
                            issue={issue}
                            active={issue.threadId === threadId}
                            showDescription={showDescription}
                            showUpdatedAt={showUpdatedAt}
                            onDetails={() => setSelected(issue)}
                          />
                        ))}
                      </ul>
                      {!column.items.length && (
                        <p className="px-3 py-8 text-center text-xs leading-6 text-muted-foreground">
                          {t(`issues.empty.${state}`)}
                        </p>
                      )}
                      {column.cursor && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 w-full"
                          disabled={!!more}
                          onClick={() => loadMore(state)}
                        >
                          {t(more === state ? 'chat.loading' : 'issues.more')}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </ScrollArea>
            </section>
          );
        })}
        {!states.length && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg bg-muted/30 text-sm text-muted-foreground">
            <p>{t('issues.noResults')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVisibleStates([...issueStates])}
            >
              {t('issues.resetFilters')}
            </Button>
          </div>
        )}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
  return (
    <section
      className={cn('min-w-0', compact && 'flex h-full min-h-0 flex-col')}
      aria-label={t('issues.heading')}
    >
      <header
        className={cn('shrink-0', compact ? 'border-b px-3 py-3' : 'mb-4')}
      >
        <IssueBoardToolbar
          projectId={projectId}
          states={visibleStates}
          onStatesChange={setVisibleStates}
          showDescription={showDescription}
          onDescriptionChange={setShowDescription}
          showUpdatedAt={showUpdatedAt}
          onUpdatedAtChange={setShowUpdatedAt}
          count={count}
          loading={loading}
          onCreate={() => setCreating('todo')}
          onClose={onClose}
        />
      </header>
      {error && (
        <div
          role="alert"
          className="mb-3 flex items-center justify-between gap-3 p-3 text-sm text-destructive"
        >
          <p>{t(error)}</p>
          <Button size="sm" variant="outline" onClick={refresh}>
            {t('session.retry')}
          </Button>
        </div>
      )}
      {compact && current && current.threadId === threadId && (
        <div className="shrink-0 space-y-2 border-b px-3 py-3">
          <p className="text-xs font-medium text-muted-foreground">
            {t('issues.current')}
          </p>
          <button
            className="block w-full rounded text-left text-sm font-medium break-words outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setSelected(current)}
          >
            #{current.id} {current.title}
          </button>
          <IssueStateBadge state={current.state} />
        </div>
      )}
      <div
        className={cn('min-w-0', compact && 'flex min-h-0 flex-1 flex-col p-3')}
      >
        {columns}
      </div>
      {creating && (
        <IssueFormDialog
          projectId={projectId}
          initialState={creating}
          settings={settings ?? (projectId ? undefined : personal.settings)}
          onClose={() => setCreating(null)}
          onSaved={setSelected}
        />
      )}
      {selected && (
        <IssueDetailSheet
          key={selected.id}
          issue={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

export default IssueBoard;
