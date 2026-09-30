import type { ThreadSummary } from '@aime/shared/threads';
import { chatApi, chatErrorKey } from '../../components/chat/api.js';

type Snapshot = {
  threads: ThreadSummary[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: ReturnType<typeof chatErrorKey> | null;
};

export function createThreadListResource(loadPage = chatApi.list) {
  let snapshot: Snapshot = {
    threads: [],
    page: -1,
    hasMore: true,
    loading: false,
    error: null,
  };
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const removed = new Set<string>();
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  function loadMore(): Promise<void> {
    if (pending) return pending;
    if (!snapshot.hasMore) return Promise.resolve();
    controller = new AbortController();
    const signal = controller.signal;
    const page = snapshot.page + 1;
    publish({ ...snapshot, loading: true, error: null });
    pending = (async () => {
      try {
        const result = await loadPage(page, signal);
        if (signal.aborted) return;
        const known = new Set(snapshot.threads.map((thread) => thread.id));
        publish({
          threads: [
            ...snapshot.threads,
            ...result.threads.filter(
              (thread) => !known.has(thread.id) && !removed.has(thread.id),
            ),
          ],
          page: result.page,
          hasMore: result.hasMore,
          loading: false,
          error: null,
        });
      } catch (cause) {
        if (!signal.aborted)
          publish({ ...snapshot, loading: false, error: chatErrorKey(cause) });
      } finally {
        if (!signal.aborted) pending = undefined;
      }
    })();
    return pending;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadMore,
    update(thread: ThreadSummary) {
      removed.delete(thread.id);
      publish({
        ...snapshot,
        threads: snapshot.threads.some((item) => item.id === thread.id)
          ? snapshot.threads.map((item) =>
              item.id === thread.id ? thread : item,
            )
          : [thread, ...snapshot.threads],
      });
    },
    remove(id: string) {
      removed.add(id);
      publish({
        ...snapshot,
        threads: snapshot.threads.filter((item) => item.id !== id),
      });
    },
    cancel() {
      controller?.abort();
      pending = undefined;
      publish({ ...snapshot, loading: false });
    },
  };
}
