import {
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Archive,
  ArchiveRestore,
  LoaderCircle,
  Search,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ThreadSummary } from '@aime/shared/threads';
import { chatApi } from '@/components/chat/api';
import { ThreadNavigationContext } from '@/components/chat/thread-navigation-context';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useThreadList } from '@/pages/threads/use-thread-list';
import { DeleteArchivedDialog } from './components/delete-archived-dialog';
import { archiveErrorKey } from './errors';

export function PersonalSettingsPage() {
  const { t, i18n } = useTranslation();
  const { updateThread } = useThreadList();
  const navigation = useContext(ThreadNavigationContext);
  if (!navigation) throw new Error('ThreadNavigationProvider is required');
  const liveThreads = useSyncExternalStore(
    navigation.subscribe,
    navigation.getArchivedThreads,
    navigation.getArchivedThreads,
  );
  const [loadedThreads, setThreads] = useState<ThreadSummary[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [loadError, setError] = useState<ReturnType<
    typeof archiveErrorKey
  > | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(20);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ThreadSummary | null>(null);
  const threads = liveThreads ?? loadedThreads;
  const loading = liveThreads === undefined && isLoading;
  const error = liveThreads === undefined ? loadError : null;

  useEffect(() => {
    const controller = new AbortController();
    void chatApi.archived(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setThreads(result);
          setLoading(false);
        }
      },
      (cause) => {
        if (!controller.signal.aborted) {
          setError(archiveErrorKey(cause));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const remove = useCallback(
    (id: string) => {
      navigation.removeArchivedThread(id);
      setThreads((current) => current.filter((thread) => thread.id !== id));
    },
    [navigation],
  );
  async function restore(thread: ThreadSummary) {
    if (restoring) return;
    setRestoring(thread.id);
    try {
      const restored = await chatApi.restore(thread.id);
      updateThread(restored);
      remove(thread.id);
      toast.success(t('personalSettings.restored'));
    } catch (cause) {
      toast.error(t(archiveErrorKey(cause)));
    } finally {
      setRestoring(null);
    }
  }
  const query = search.trim().toLocaleLowerCase();
  const filtered = threads.filter((thread) =>
    (thread.title || t('chat.new')).toLocaleLowerCase().includes(query),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader
        title={t('nav.personalSettings')}
        description={t('personalSettings.description')}
      />
      <section
        aria-labelledby="archived-chats-title"
        className="overflow-hidden rounded-xl border bg-card"
      >
        <div className="space-y-4 border-b p-5 sm:p-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Archive
                className="mr-1 size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <h2 id="archived-chats-title" className="text-lg font-semibold">
                {t('personalSettings.archivedChats')}
              </h2>
              {!loading && !error && (
                <Badge variant="secondary">{threads.length}</Badge>
              )}
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t('personalSettings.archiveHint')}
            </p>
          </div>
          <div className="relative max-w-sm">
            <Search
              className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label={t('personalSettings.search')}
              placeholder={t('personalSettings.search')}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setVisibleCount(20);
              }}
              className="pl-9"
            />
          </div>
        </div>
        <ScrollArea
          viewportProps={{ className: 'max-h-[65dvh] [&>div]:block!' }}
        >
          {loading ? (
            <div
              role="status"
              aria-label={t('chat.loading')}
              className="space-y-6 p-6"
            >
              {[0, 1, 2].map((index) => (
                <div key={index} className="space-y-2">
                  <Skeleton className="h-4 w-2/3 max-w-sm" />
                  <Skeleton className="h-3 w-40" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 p-6 text-sm"
            >
              <p>{t(error)}</p>
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  setLoading(true);
                  setAttempt((value) => value + 1);
                }}
              >
                {t('providers.retry')}
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <Archive
                className="mx-auto mb-4 size-8 text-muted-foreground"
                aria-hidden="true"
              />
              <h3 className="font-medium">
                {t(
                  query
                    ? 'personalSettings.noMatches'
                    : 'personalSettings.empty',
                )}
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                {t(
                  query
                    ? 'personalSettings.noMatchesHint'
                    : 'personalSettings.emptyHint',
                )}
              </p>
            </div>
          ) : (
            <ul
              className="divide-y"
              aria-label={t('personalSettings.archivedChats')}
            >
              {filtered.slice(0, visibleCount).map((thread) => (
                <li
                  key={thread.id}
                  className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-6"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3
                        className="truncate text-sm font-medium"
                        title={thread.title || t('chat.new')}
                      >
                        {thread.title || t('chat.new')}
                      </h3>
                      <Badge variant="outline">
                        {t('personalSettings.archived')}
                      </Badge>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {t('personalSettings.archivedOn', {
                        date: new Date(
                          thread.archivedAt ?? thread.updatedAt,
                        ).toLocaleString(i18n.language, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }),
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!restoring}
                      onClick={() => void restore(thread)}
                      aria-label={t('personalSettings.restoreNamed', {
                        title: thread.title || t('chat.new'),
                      })}
                    >
                      {restoring === thread.id ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <ArchiveRestore />
                      )}
                      {t('personalSettings.restore')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={!!restoring}
                      onClick={() => setDeleting(thread)}
                      aria-label={t('personalSettings.deleteNamed', {
                        title: thread.title || t('chat.new'),
                      })}
                    >
                      <Trash2 />
                      {t('personalSettings.delete')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!loading && !error && filtered.length > visibleCount && (
            <div className="border-t p-4 text-center">
              <Button
                variant="ghost"
                onClick={() => setVisibleCount((value) => value + 20)}
              >
                {t('chat.moreThreads')}
              </Button>
            </div>
          )}
        </ScrollArea>
      </section>
      {deleting && (
        <DeleteArchivedDialog
          thread={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => remove(deleting.id)}
        />
      )}
    </div>
  );
}
