import { useCallback, useEffect, useRef, useState } from 'react';
import { issueStates, type Issue, type IssueState } from '@aime/shared/issues';
import { issueApi, issueErrorKey } from './api';

type Column = { items: Issue[]; count: number; cursor: number | null };
type Board = Record<IssueState, Column>;
const emptyColumn = (): Column => ({ items: [], count: 0, cursor: null });
const empty = (): Board => ({
  decision: emptyColumn(),
  todo: emptyColumn(),
  in_progress: emptyColumn(),
  done: emptyColumn(),
});

export function useIssues(projectId?: string, compact = false) {
  const [board, setBoard] = useState<Board>(empty);
  const latest = useRef(board);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ReturnType<typeof issueErrorKey> | null>(
    null,
  );
  const [more, setMore] = useState<IssueState | null>(null);
  const [revision, setRevision] = useState(0);
  const requested = useRef<Record<IssueState, number>>({
    decision: 0,
    todo: 0,
    in_progress: 0,
    done: 0,
  });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const entries = await Promise.all(
          issueStates.map(async (state) => {
            const target = Math.max(
              compact ? 5 : 15,
              latest.current[state].items.length,
              requested.current[state],
            );
            let cursor: number | undefined;
            const items: Issue[] = [];
            let count = 0;
            do {
              const result = await issueApi.list(
                {
                  projectId,
                  state,
                  cursor,
                  limit: Math.min(100, target - items.length),
                },
                { signal: controller.signal },
              );
              items.push(...result.items);
              count = result.counts[state];
              cursor = result.nextCursor ?? undefined;
            } while (cursor && items.length < target);
            return [state, { items, count, cursor: cursor ?? null }] as const;
          }),
        );
        if (controller.signal.aborted) return;
        const next = Object.fromEntries(entries) as Board;
        latest.current = next;
        setBoard(next);
        setError(null);
      } catch (cause) {
        if (!controller.signal.aborted) setError(issueErrorKey(cause));
      } finally {
        running = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          setMore(null);
        }
      }
    };
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15000);
    const changed = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('issues-changed', refresh);
    window.addEventListener('focus', changed);
    document.addEventListener('visibilitychange', changed);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('issues-changed', refresh);
      window.removeEventListener('focus', changed);
      document.removeEventListener('visibilitychange', changed);
    };
  }, [projectId, compact, revision, refresh]);
  const loadMore = (state: IssueState) => {
    if (more) return;
    requested.current[state] =
      latest.current[state].items.length + (compact ? 5 : 15);
    setMore(state);
    refresh();
  };
  return { board, loading, error, more, loadMore, refresh };
}
