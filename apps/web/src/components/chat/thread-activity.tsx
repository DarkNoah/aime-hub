import {
  CircleCheck,
  CircleMinus,
  CirclePause,
  CircleStop,
  CircleX,
  Clock3,
  Hand,
  Hourglass,
  LoaderCircle,
  MessageCircle,
  ShieldAlert,
  SkipForward,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ThreadStatus } from '@aime/shared/threads';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const threadStatusIcons: Record<ThreadStatus, LucideIcon> = {
  idle: MessageCircle,
  pending: Clock3,
  running: LoaderCircle,
  success: CircleCheck,
  failed: CircleX,
  tripwire: ShieldAlert,
  suspended: Hand,
  waiting: Hourglass,
  canceled: CircleStop,
  bailed: CircleMinus,
  paused: CirclePause,
  skipped: SkipForward,
};

export function ThreadStatusIcon({
  status,
  className,
}: {
  status: ThreadStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t(`chat.status.${status}`);
  const Icon = threadStatusIcons[status];

  return (
    <Badge
      variant="ghost"
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'size-3.5 rounded-none border-0 p-0 text-muted-foreground',
        (status === 'running' || status === 'pending' || status === 'success') &&
          'text-primary',
        (status === 'failed' || status === 'tripwire') && 'text-destructive',
        (status === 'suspended' || status === 'waiting') &&
          'text-amber-700 dark:text-amber-400',
        className,
      )}
    >
      <span
        className={cn(
          'inline-flex',
          status === 'running' && 'motion-safe:animate-spin',
        )}
      >
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
    </Badge>
  );
}

export function ThreadActivityTitle({
  children,
  active,
  className,
}: {
  children: string;
  active: boolean;
  className?: string;
}) {
  const classes = cn('min-w-0 truncate', className);
  return active ? (
    <Shimmer as="span" className={classes}>
      {children}
    </Shimmer>
  ) : (
    <span className={classes}>{children}</span>
  );
}

export function ThreadStatusBadge({
  status,
  className,
}: {
  status: ThreadStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t(`chat.status.${status}`);
  if(status == 'success' || status == 'pending') {
    return null;
  }
  return (
    <Badge
      variant={
        status === 'failed' || status === 'tripwire'
          ? 'destructive'
          : 'secondary'
      }
      className={cn(
        'shrink-0',
        status === 'running' &&
          'bg-transparent ',
        status !== 'running' &&
          status !== 'failed' &&
          status !== 'tripwire' &&
          'bg-blue-600 text-white',
        className,
      )}
      title={label}
      aria-label={label}
    >
      {status === 'running' ? (
        <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
      ) : (
        label
      )}
    </Badge>
  );
}

export function RunningThreadCount({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t('projects.runningThreads', { count });
  return (
    <Badge
      variant="secondary"
      className={cn('shrink-0 tabular-nums', className)}
      title={`${label} · ${t('projects.runningThreadsHint')}`}
      aria-label={label}
    >
      <LoaderCircle
        aria-hidden
        className={count > 0 ? 'motion-safe:animate-spin' : undefined}
      />
      <span aria-hidden>{count}</span>
    </Badge>
  );
}
