import { useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ThreadSummary } from '@aime/shared/threads';
import { SidebarPageList } from '@/components/sidebar-page-list';
import { ThreadListItems } from './thread-list-items';
import {
  useThreadListResource,
  type ThreadListResource,
} from './use-thread-list';

export type ThreadListProps = {
  /** Exact plugin ID; omitted means personal chats without a plugin. */
  plugin?: string;
  /** An explicit resource takes precedence, for example a project's chat list. */
  resource?: ThreadListResource;
  selectedId?: string;
  label?: string;
  maxHeight?: CSSProperties['maxHeight'];
  onSelect: (id: string) => void;
  onAction: (thread: ThreadSummary, mode: 'rename' | 'delete') => void;
  canManage?: (thread: ThreadSummary) => boolean;
};

/** Shared sidebar/picker list with pagination, live status and optional plugin scope. */
export function ThreadList({
  plugin,
  resource: suppliedResource,
  selectedId,
  label,
  maxHeight,
  onSelect,
  onAction,
  canManage,
}: ThreadListProps) {
  const { t } = useTranslation();
  const resource = useThreadListResource(plugin, suppliedResource);
  const { threads, loading, error, hasMore } = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  useEffect(() => {
    if (resource.getSnapshot().page < 0) void resource.loadMore();
  }, [resource]);
  return (
    <SidebarPageList
      label={label ?? t('chat.threadList')}
      moreLabel={t('chat.moreThreads')}
      loading={loading}
      error={error}
      hasMore={hasMore}
      loadMore={resource.loadMore}
      maxHeight={maxHeight}
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
        canManage={canManage}
      />
    </SidebarPageList>
  );
}
