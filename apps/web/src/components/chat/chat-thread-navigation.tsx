import {
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Check,
  ChevronDown,
  MessagesSquare,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { SidebarPageList } from '@/components/sidebar-page-list';
import { ThreadStatusBadge } from './thread-activity';
import { ThreadPluginBadge } from './thread-plugin-badge';
import type { createThreadListResource } from './thread-list-resource';
import { Input } from '@/components/ui/input';
import { FloatingChatContext } from './layout-context';

export type ChatThreadNavigationProps = {
  resource: ReturnType<typeof createThreadListResource>;
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
};

/** Shared by the docked and floating chat headers. */
export function ChatThreadNavigation({
  resource,
  selectedId,
  onSelect,
  onNew,
}: ChatThreadNavigationProps) {
  const { t } = useTranslation();
  const floating = useContext(FloatingChatContext);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(10);
  const catalog = useSyncExternalStore(
    resource.subscribe,
    resource.getCatalogSnapshot,
    resource.getCatalogSnapshot,
  );
  const needle = query.trim().toLocaleLowerCase();
  const matches = useMemo(
    () =>
      catalog.threads.filter(
        (thread) =>
          !needle ||
          (thread.title || t('chat.new')).toLocaleLowerCase().includes(needle),
      ),
    [catalog.threads, needle, t],
  );
  const needsMore = catalog.hasMore && matches.length <= limit;
  // The navigation feed includes all titles. Before it arrives, scan bounded HTTP
  // pages until this result page is filled or the project has no more threads.
  useEffect(() => {
    if (open && needsMore && !catalog.loading && !catalog.error)
      void resource.loadMore();
  }, [open, needsMore, catalog, resource]);
  const searching = catalog.loading || (needsMore && !catalog.error);
  const hasMore = matches.length > limit || catalog.hasMore;
  const threads = matches.slice(0, limit);
  function changeQuery(value: string) {
    setQuery(value);
    setLimit(10);
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) changeQuery('');
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant={floating ? 'ghost' : 'outline'}
            size={floating ? 'icon-sm' : 'sm'}
            className={floating ? 'size-7 p-0' : 'gap-1.5'}
            aria-label={t('chat.switchThread')}
            title={t('chat.switchThread')}
          >
            <MessagesSquare
              className={floating ? 'size-3.5' : 'size-4'}
              aria-hidden="true"
            />
            {!floating && (
              <>
                <span className="hidden @sm/chat:inline">
                  {t('chat.switchThread')}
                </span>
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-80 max-w-[calc(100vw-2rem)] p-2"
        >
          <div className="relative mb-2">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              placeholder={t('chat.searchThreads')}
              aria-label={t('chat.searchThreads')}
              maxLength={200}
              className="pl-8 pr-8"
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-1 right-1 size-7"
                aria-label={t('chat.clearSearch')}
                onClick={() => changeQuery('')}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
          <SidebarPageList
            key={needle}
            loading={searching}
            error={catalog.error}
            hasMore={hasMore}
            loadMore={async () => {
              if (catalog.error) await resource.loadMore();
              else setLimit((value) => value + 10);
            }}
            label={t('chat.switchThread')}
            moreLabel={t('chat.moreThreads')}
            maxHeight="min(18rem,40dvh)"
          >
            {!threads.length && !searching && !catalog.error && (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                {t(needle ? 'chat.noMatchingThreads' : 'projects.emptyChats')}
              </p>
            )}
            {threads.map((thread) => (
              <Button
                key={thread.id}
                variant={selectedId === thread.id ? 'secondary' : 'ghost'}
                className="h-10 w-full justify-start gap-2 px-2"
                aria-current={selectedId === thread.id ? 'page' : undefined}
                title={thread.title || t('chat.new')}
                onClick={() => {
                  setOpen(false);
                  changeQuery('');
                  if (thread.id !== selectedId) onSelect(thread.id);
                }}
              >
                <Check
                  className={
                    selectedId === thread.id
                      ? 'size-3.5 shrink-0'
                      : 'size-3.5 shrink-0 invisible'
                  }
                />
                <ThreadPluginBadge
                  plugin={thread.plugin}
                  className="max-w-24 px-1.5 py-0 text-[10px]"
                />
                <span className="min-w-0 flex-1 truncate text-left">
                  {thread.title || t('chat.new')}
                </span>
                <ThreadStatusBadge
                  status={thread.status}
                  className="shrink-0 text-[10px]"
                />
              </Button>
            ))}
          </SidebarPageList>
        </PopoverContent>
      </Popover>
      <Button
        variant={floating ? 'ghost' : 'outline'}
        size={floating ? 'icon-sm' : 'sm'}
        className={floating ? 'size-7 p-0' : 'gap-1.5'}
        aria-label={t('chat.new')}
        title={t('chat.new')}
        onClick={onNew}
      >
        <Plus className={floating ? 'size-3.5' : 'size-4'} aria-hidden="true" />
        {!floating && t('chat.new')}
      </Button>
    </div>
  );
}
