import { useEffect, useRef } from 'react';
import { LoaderCircle, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ThreadSummary } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useThreadList } from '../use-thread-list';

export function ThreadList({
  selectedId,
  onSelect,
  onAction,
}: {
  selectedId?: string;
  onSelect: (id: string) => void;
  onAction: (thread: ThreadSummary, mode: 'rename' | 'delete') => void;
}) {
  const { t } = useTranslation();
  const { threads, loading, error, hasMore, loadMore } = useThreadList();
  const scrollRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || loading || error || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.intersectionRatio >= 0.1))
          void loadMore();
      },
      { root: scrollRef.current, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, error, hasMore, loadMore]);

  return (
    <nav
      ref={scrollRef}
      aria-label={t('chat.threadList')}
      className="max-h-[min(22.5rem,45dvh)] overflow-y-auto overscroll-contain"
    >
      {!loading && !error && !threads.length && (
        <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
          {t('chat.emptyList')}
        </p>
      )}
      {threads.map((thread) => (
        <div
          key={thread.id}
          className={cn(
            'group flex h-9 items-center rounded-md transition-colors hover:bg-accent/60',
            thread.id === selectedId && 'bg-accent text-accent-foreground',
          )}
        >
          <button
            type="button"
            aria-current={thread.id === selectedId ? 'page' : undefined}
            title={thread.title || t('chat.new')}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelect(thread.id)}
          >
            <span className="truncate text-[13px]">
              {thread.title || t('chat.new')}
            </span>
            {thread.status !== 'idle' && (
              <Badge
                variant={
                  thread.status === 'error' ? 'destructive' : 'secondary'
                }
                className="shrink-0 px-1 py-0 text-[10px]"
              >
                {t(`chat.status.${thread.status}`)}
              </Badge>
            )}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-7 shrink-0"
                aria-label={t('chat.actions', {
                  title: thread.title || t('chat.new'),
                })}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onAction(thread, 'rename')}>
                {t('chat.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                disabled={
                  thread.status === 'running' ||
                  thread.status === 'stopping' ||
                  !!thread.queue.length
                }
                onSelect={() => onAction(thread, 'delete')}
              >
                {t('chat.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}
      {error && (
        <div role="alert" className="space-y-2 px-3 py-2 text-xs">
          <p>{t(error)}</p>
          <Button size="sm" variant="outline" onClick={() => void loadMore()}>
            {t('providers.retry')}
          </Button>
        </div>
      )}
      {hasMore && !error && (
        <div
          ref={sentinelRef}
          className="flex min-h-8 items-center justify-center"
        >
          {loading ? (
            <span role="status" aria-label={t('chat.loading')}>
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            </span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-xs text-muted-foreground"
              onClick={() => void loadMore()}
            >
              {t('chat.moreThreads')}
            </Button>
          )}
        </div>
      )}
    </nav>
  );
}
