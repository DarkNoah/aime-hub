import { useTranslation } from 'react-i18next';
import type { ThreadSummary } from '@aime/shared/threads';
import { SidebarPageList } from '@/components/sidebar-page-list';
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
  return (
    <SidebarPageList
      label={t('chat.threadList')}
      moreLabel={t('chat.moreThreads')}
      loading={loading}
      error={error}
      hasMore={hasMore}
      loadMore={loadMore}
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
    </SidebarPageList>
  );
}
