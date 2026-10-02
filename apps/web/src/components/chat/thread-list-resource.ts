import type { ThreadSummary } from '@aime/shared/threads';
import { chatApi, chatErrorKey } from './api.js';

type Snapshot = {
  threads: ThreadSummary[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: ReturnType<typeof chatErrorKey> | null;
};

export function createThreadListResource(
  loadPage = chatApi.list,
  pageSize = 10,
) {
  let liveThreads: ThreadSummary[] | undefined;
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
    if (!snapshot.hasMore) return Promise.resolve();
    if (liveThreads) {
      const size = snapshot.threads.length + pageSize;
      publish({
        ...snapshot,
        threads: liveThreads.slice(0, size),
        page: snapshot.page + 1,
        hasMore: liveThreads.length > size,
        loading: false,
        error: null,
      });
      return Promise.resolve();
    }
    if (pending) return pending;
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
    synchronize(threads: ThreadSummary[]) {
      controller?.abort();
      pending = undefined;
      removed.clear();
      const previous = liveThreads ?? snapshot.threads;
      const incoming = new Map(threads.map((thread) => [thread.id, thread]));
      const known = new Set(previous.map((thread) => thread.id));
      const added = threads
        .filter((thread) => !known.has(thread.id))
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
        );
      liveThreads = liveThreads
        ? [
            ...added,
            ...previous.flatMap((thread) =>
              incoming.has(thread.id) ? [incoming.get(thread.id)!] : [],
            ),
          ]
        : [...threads].sort(
            (a, b) =>
              b.updatedAt.localeCompare(a.updatedAt) ||
              b.id.localeCompare(a.id),
          );
      const size = Math.max(pageSize, snapshot.threads.length);
      publish({
        ...snapshot,
        threads: liveThreads.slice(0, size),
        page: Math.max(0, snapshot.page),
        hasMore: liveThreads.length > size,
        loading: false,
        error: null,
      });
    },
    update(thread: ThreadSummary, authoritative = false) {
      // Once connected, only the ordered global feed writes summaries. HTTP acknowledgements
      // and the open chat's independent message stream can arrive after a newer status.
      if (liveThreads && !authoritative) return;
      removed.delete(thread.id);
      if (liveThreads) {
        const exists = liveThreads.some((item) => item.id === thread.id);
        liveThreads = exists
          ? liveThreads.map((item) => (item.id === thread.id ? thread : item))
          : [thread, ...liveThreads];
        const visible = snapshot.threads.some((item) => item.id === thread.id);
        const size = snapshot.threads.length + (visible ? 0 : 1);
        if (exists && !visible)
          liveThreads = [
            thread,
            ...liveThreads.filter((item) => item.id !== thread.id),
          ];
        publish({
          ...snapshot,
          threads: liveThreads.slice(0, size),
          hasMore: liveThreads.length > size,
        });
        return;
      }
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
      if (liveThreads)
        liveThreads = liveThreads.filter((item) => item.id !== id);
      publish({
        ...snapshot,
        threads: snapshot.threads.filter((item) => item.id !== id),
        hasMore: liveThreads
          ? liveThreads.length >
            snapshot.threads.filter((item) => item.id !== id).length
          : snapshot.hasMore,
      });
    },
    cancel() {
      controller?.abort();
      pending = undefined;
      publish({ ...snapshot, loading: false });
    },
  };
}
