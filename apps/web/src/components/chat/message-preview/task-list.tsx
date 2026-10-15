import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Item, ItemContent, ItemTitle } from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  summarizeTasks,
  type TaskSnapshot,
  type TaskStatus,
} from './task-data';

const statusLabels = {
  pending: 'chat.tasks.pending',
  in_progress: 'chat.tasks.inProgress',
  completed: 'chat.tasks.completed',
} as const;

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const { t } = useTranslation();
  return (
    <Badge variant={status === 'pending' ? 'outline' : 'secondary'}>
      {t(statusLabels[status])}
    </Badge>
  );
}

export function TaskList({
  tasks,
  title,
  showProgress = true,
  highlightId,
}: {
  tasks: TaskSnapshot[];
  title: string;
  showProgress?: boolean;
  highlightId?: string;
}) {
  const { t } = useTranslation();
  const counts = summarizeTasks(tasks);
  const progress = counts.total ? (counts.completed / counts.total) * 100 : 0;
  const progressLabel = t('chat.tasks.progress', {
    completed: counts.completed,
    total: counts.total,
  });

  return (
    <section aria-label={title} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        {showProgress && counts.total > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {progressLabel}
          </span>
        )}
      </div>
      {showProgress && counts.total > 0 && (
        <div className="space-y-3">
          <Progress
            value={progress}
            aria-label={t('chat.tasks.progressLabel')}
            aria-valuenow={progress}
            aria-valuetext={progressLabel}
            className="h-1.5 [&>div]:motion-reduce:transition-none"
          />
          <div className="flex flex-wrap gap-2">
            {counts.allCompleted ? (
              <Badge variant="secondary">{t('chat.tasks.allCompleted')}</Badge>
            ) : (
              <>
                <Badge variant="secondary">
                  {t('chat.tasks.inProgressCount', {
                    count: counts.in_progress,
                  })}
                </Badge>
                <Badge variant="outline">
                  {t('chat.tasks.pendingCount', { count: counts.pending })}
                </Badge>
              </>
            )}
          </div>
        </div>
      )}
      {tasks.length === 0 ? (
        <p className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">
          {t(showProgress ? 'chat.tasks.empty' : 'chat.tasks.clearRequest')}
        </p>
      ) : (
        <ol className="min-w-0 space-y-2">
          {tasks.map((task, index) => {
            const highlighted = !!highlightId && task.id === highlightId;
            const Icon =
              task.status === 'completed'
                ? CheckCircle2
                : task.status === 'in_progress'
                  ? LoaderCircle
                  : Circle;
            return (
              <li key={`${task.id ?? 'task'}:${index}`} className="min-w-0">
                <Item
                  variant={highlighted ? 'muted' : 'outline'}
                  size="sm"
                  className="min-w-0 flex-nowrap items-start px-3"
                >
                  <Icon
                    className={cn(
                      'mt-0.5 size-4 shrink-0 text-muted-foreground',
                      task.status === 'in_progress' && 'text-primary',
                      task.status === 'completed' &&
                        'text-emerald-600 dark:text-emerald-400',
                    )}
                    aria-hidden="true"
                  />
                  <ItemContent className="min-w-0 gap-2">
                    <ItemTitle className="block w-full whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">
                      {task.content}
                    </ItemTitle>
                    {task.status === 'in_progress' &&
                      task.activeForm &&
                      task.activeForm !== task.content && (
                        <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                          {task.activeForm}
                        </p>
                      )}
                    <div className="flex flex-wrap items-center gap-2">
                      <TaskStatusBadge status={task.status} />
                      {highlighted && (
                        <Badge variant="outline">
                          {t('chat.tasks.target')}
                        </Badge>
                      )}
                    </div>
                    {task.id && (
                      <p className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                        {task.id}
                      </p>
                    )}
                  </ItemContent>
                </Item>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
