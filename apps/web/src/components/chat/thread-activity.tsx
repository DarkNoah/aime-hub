import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ThreadStatus } from '@aime/shared/threads';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

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
