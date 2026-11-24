import { useEffect, useRef, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Keeps loaded rows in place when appending a page or editing a single row. */
export function useMarketSearch<T extends { symbol: string }>(
  pluginId: string,
  path: string | null,
  refreshMs = 0,
) {
  const [page, setPage] = useState<Page<T>>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const active = useRef<AbortController | null>(null);
  const pendingMore = useRef(false);
  const loadedPaths = useRef<string[]>([]);
  const edits = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    pendingMore.current = false;
    loadedPaths.current = [];
    setPage({ items: [], nextCursor: null });
    setError(false);
    setLoadingMore(false);
    setLoading(!!path);
    if (!path) return () => controller.abort();
    const timer = setTimeout(async () => {
      try {
        const result = await pluginRequest<Page<T>>(pluginId, path, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          loadedPaths.current = [path];
          setPage(result);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pluginId, path, attempt]);

  // Refresh one loaded contract page per interval. Appended pages and their
  // scroll position survive progress updates, including a delayed API reply.
  useEffect(() => {
    if (!path || !refreshMs) return;
    const controller = new AbortController();
    let index = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const pages = loadedPaths.current;
      const target = pages.length ? pages[index++ % pages.length] : null;
      const revision = edits.current;
      try {
        if (target && !document.hidden) {
          const result = await pluginRequest<Page<T>>(pluginId, target, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted && revision === edits.current) {
            const fresh = new Map(
              result.items.map((item) => [item.symbol, item]),
            );
            setPage((current) => ({
              ...current,
              items: current.items.map(
                (item) => fresh.get(item.symbol) ?? item,
              ),
            }));
          }
        }
      } catch {
        // Keep the last confirmed rows until the next poll.
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void refresh(), refreshMs);
      }
    }
    timer = setTimeout(() => void refresh(), refreshMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pluginId, path, refreshMs, attempt]);

  async function loadMore() {
    const signal = active.current?.signal;
    if (
      !path ||
      !page.nextCursor ||
      !signal ||
      signal.aborted ||
      pendingMore.current
    )
      return;
    pendingMore.current = true;
    setLoadingMore(true);
    setError(false);
    try {
      const url = `${path}&cursor=${encodeURIComponent(page.nextCursor)}`;
      const next = await pluginRequest<Page<T>>(pluginId, url, { signal });
      if (!signal.aborted) {
        loadedPaths.current.push(url);
        setPage((current) => ({
          items: [...current.items, ...next.items],
          nextCursor: next.nextCursor,
        }));
      }
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) {
        pendingMore.current = false;
        setLoadingMore(false);
      }
    }
  }

  return {
    ...page,
    loading,
    loadingMore,
    error,
    loadMore,
    retry: () => setAttempt((value) => value + 1),
    updateItems: (update: (items: T[]) => T[]) => {
      edits.current++;
      setPage((current) => ({ ...current, items: update(current.items) }));
    },
  };
}
