import { useEffect, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import type { MarketPositionsPage } from '../../market-positions';
import { errorText } from '../strategies/format';

export function useMarketPositions(pluginId: string, engine?: string) {
  const [cursors, setCursors] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    path: string;
    data: MarketPositionsPage;
  }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const before = cursors.at(-1);
  const path = `/strategies/monitors/positions${before ? `?before=${encodeURIComponent(before)}` : ''}`;
  useEffect(() => {
    if (!engine) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setError('');
    async function poll() {
      try {
        const data = await pluginRequest<MarketPositionsPage>(pluginId, path, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setState((old) =>
          old?.path === path &&
          JSON.stringify(old.data) === JSON.stringify(data)
            ? old
            : { path, data },
        );
        setError('');
      } catch (error) {
        if (!abort.signal.aborted) setError(errorText(error));
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
  }, [pluginId, engine, path, revision]);
  const data = state?.data;
  const historyReady = state?.path === path;
  return {
    data,
    historyReady,
    loading,
    error,
    page: cursors.length + 1,
    refresh: () => setRevision((value) => value + 1),
    newer: () => setCursors((old) => old.slice(0, -1)),
    latest: () => setCursors([]),
    older: () => {
      if (!loading && historyReady && data?.next)
        setCursors((old) => [...old, data.next!]);
    },
  };
}
