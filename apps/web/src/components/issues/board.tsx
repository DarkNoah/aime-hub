import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, CircleDot, MoreHorizontal, Plus, X } from 'lucide-react';
import { issueStates, type Issue } from '@aime/shared/issues';
import type { ChatSettings } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { usePersonalChatSettings } from '@/components/chat/use-personal-chat-settings';
import { cn } from '@/lib/utils';
import { useIssues } from './use-issues';
import { IssueStateBadge, IssueThreadLink } from './presentation';
import { IssueFormDialog } from './form-dialog';
import { IssueDetailSheet } from './detail-sheet';
import { issueApi } from './api';

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
  const { t, i18n } = useTranslation();
  const personal = usePersonalChatSettings(projectId);
  const { board, loading, error, more, loadMore, refresh } = useIssues(
    projectId,
    compact,
  );
  const [creating, setCreating] = useState(false);
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
  const row = (issue: Issue) => (
    <li
      key={issue.id}
      className={cn(
        'group flex items-center gap-1 border-b last:border-b-0',
        issue.threadId === threadId && 'bg-primary/5',
      )}
    >
      <IssueThreadLink
        issue={issue}
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-3 transition-colors hover:bg-accent/70',
          !compact && 'sm:flex-row sm:items-center sm:gap-4',
        )}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            #{issue.id}
          </span>
          <span className="line-clamp-2 min-w-0 break-words text-sm font-medium leading-6">
            {issue.title}
          </span>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
          <time dateTime={issue.updatedAt}>
            {new Date(issue.updatedAt).toLocaleDateString(i18n.language, {
              month: 'short',
              day: 'numeric',
            })}
          </time>
          <ArrowUpRight className="size-3.5" aria-hidden />
        </div>
      </IssueThreadLink>
      <Button
        variant="ghost"
        size="icon-xs"
        className="mr-1 shrink-0"
        aria-label={t('issues.detailsFor', { title: issue.title })}
        onClick={() => setSelected(issue)}
      >
        <MoreHorizontal className="size-4" />
      </Button>
    </li>
  );
  const groups = (
    <div className="flex flex-col gap-4">
      {issueStates.map((state) => {
        const column = board[state];
        const content = (
          <>
            <ul>{column.items.map(row)}</ul>
            {!loading && !column.items.length && (
              <p className="px-4 py-4 text-sm leading-6 text-muted-foreground">
                {t(`issues.empty.${state}`)}
              </p>
            )}
            {column.cursor && (
              <Button
                variant="ghost"
                size="sm"
                className="my-2 w-full"
                disabled={!!more}
                onClick={() => loadMore(state)}
              >
                {t(more === state ? 'chat.loading' : 'issues.more')}
              </Button>
            )}
          </>
        );
        return (
          <section
            key={state}
            aria-label={t(`issues.state.${state}`)}
            className="min-w-0 rounded-lg border bg-card"
          >
            <header className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-3">
              <IssueStateBadge state={state} />
              <Badge variant="secondary" className="tabular-nums">
                {column.count}
              </Badge>
            </header>
            {loading ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            ) : (
              content
            )}
          </section>
        );
      })}
    </div>
  );
  return (
    <section
      className={cn('min-w-0', compact && 'flex h-full min-h-0 flex-col')}
      aria-label={t('issues.heading')}
    >
      <header
        className={cn(
          'flex flex-wrap items-center justify-between gap-3',
          compact ? 'shrink-0 border-b px-4 py-3' : 'mb-4',
        )}
      >
        <div className="flex items-center gap-2">
          <CircleDot className="size-4 text-primary" aria-hidden />
          <h2 className="text-base font-semibold">{t('issues.heading')}</h2>
          <Badge variant="outline">
            {t(projectId ? 'issues.project' : 'issues.personal')}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus />
            {t('issues.create')}
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={t('nav.close')}
            >
              <X />
            </Button>
          )}
        </div>
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
      {compact ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            {current && current.threadId === threadId && (
              <div className="space-y-2 border-b pb-4">
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
            {groups}
          </div>
        </ScrollArea>
      ) : (
        groups
      )}
      {creating && (
        <IssueFormDialog
          projectId={projectId}
          settings={settings ?? (projectId ? undefined : personal.settings)}
          onClose={() => setCreating(false)}
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
