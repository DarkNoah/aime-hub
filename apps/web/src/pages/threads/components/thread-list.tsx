import { useEffect, useRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ThreadSummary } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ThreadListItems } from '@/components/chat/thread-list-items';
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
  const scrollRef = useRef<HTMLDivElement>(null);
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
    <ScrollArea
      className="overflow-hidden pr-2"
      viewportProps={{
        ref: scrollRef,
        role: 'navigation',
        'aria-label': t('chat.threadList'),
        className:
          'max-h-[min(22.5rem,45dvh)] overscroll-contain [&>div]:block!',
      }}
    >
      {!loading && !error && !threads.length && (
        <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
          {t('chat.emptyList')}
        </p>
      )}
      <ThreadListItems
        threads={threads}
        selectedId={selectedId}
        onSelect={onSelect}
        onAction={onAction}
      />
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
    </ScrollArea>
  );
}
