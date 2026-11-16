import { useEffect, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import type { MarketPositionsPage } from '../../market-positions';
import { errorText } from '../strategies/format';

export function useMarketPositions(pluginId: string, engine?: string) {
  const [{ strategyIds, cursors }, setQuery] = useState<{
    strategyIds: string[];
    cursors: string[];
  }>({ strategyIds: [], cursors: [] });
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    context: string;
    scope: string;
    path: string;
    data: MarketPositionsPage;
  }>();
  const [failure, setFailure] = useState<{
    scope: string;
    path: string;
    message: string;
  }>();
  const [loading, setLoading] = useState(true);
  const before = cursors.at(-1);
  const params = new URLSearchParams();
  for (const id of strategyIds) params.append('strategy', id);
  if (before) params.set('before', before);
  const path = `/strategies/monitors/positions${params.size ? `?${params}` : ''}`;
  const context = JSON.stringify([pluginId, engine]);
  const scope = JSON.stringify([context, strategyIds]);
  const error =
    failure?.scope === scope && failure.path === path ? failure.message : '';
  useEffect(() => {
    if (!engine) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setFailure(undefined);
    async function poll() {
      try {
        const data = await pluginRequest<MarketPositionsPage>(pluginId, path, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setState((old) =>
          old?.scope === scope &&
          old.path === path &&
          JSON.stringify(old.data) === JSON.stringify(data)
            ? old
            : { context, scope, path, data },
        );
        setFailure(undefined);
      } catch (error) {
        if (!abort.signal.aborted)
          setFailure({ scope, path, message: errorText(error) });
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void poll(), document.hidden ? 10000 : 3000);
        }
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, engine, context, scope, path, revision]);
  // Keep the last successful page only within the same strategy selection.
  const data = state?.scope === scope ? state.data : undefined;
  const historyReady = !!data && state?.path === path;
  return {
    data,
    strategies: state?.context === context ? state.data.strategies : [],
    strategyIds,
    filterKey: scope,
    setStrategyIds: (ids: string[]) =>
      setQuery({ strategyIds: [...new Set(ids)].sort(), cursors: [] }),
    historyReady,
    loading: loading || (!historyReady && !error),
    error,
    page: cursors.length + 1,
    refresh: () => setRevision((value) => value + 1),
    newer: () =>
      setQuery((old) => ({ ...old, cursors: old.cursors.slice(0, -1) })),
    latest: () => setQuery((old) => ({ ...old, cursors: [] })),
    older: () => {
      if (!loading && historyReady && data?.next)
        setQuery((old) => ({ ...old, cursors: [...old.cursors, data.next!] }));
    },
  };
}
