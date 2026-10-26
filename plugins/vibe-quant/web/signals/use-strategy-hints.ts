import { useEffect, useRef, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import { toast } from 'sonner';
import type { MarketStrategyHint, SignalMonitor } from '../../signal-types';
import { errorText } from '../strategies/format';

export function useStrategyHints(
  pluginId: string,
  symbol: string,
  engine?: string,
) {
  const key = `${engine}:${symbol}`;
  const [state, setState] = useState<{
    key: string;
    items: MarketStrategyHint[];
  }>({ key: '', items: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setError('');
    if (!symbol || !engine) return;
    setLoading(true);
    const poll = async () => {
      const started = revision.current;
      try {
        const items = await pluginRequest<MarketStrategyHint[]>(
          pluginId,
          `/strategies/monitors?symbol=${encodeURIComponent(symbol)}`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        if (started === revision.current && !pending.current)
          setState((old) => {
            if (
              old.key === key &&
              JSON.stringify(old.items) === JSON.stringify(items)
            )
              return old;
            return { key, items };
          });
        setError('');
      } catch (error) {
        if (!abort.signal.aborted) setError(errorText(error));
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          timer = setTimeout(poll, document.hidden ? 10000 : 2000);
        }
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, symbol, engine, key]);
  function add(item: MarketStrategyHint) {
    revision.current++;
    setState((old) => ({
      key,
      items: [
        item,
        ...(old.key === key ? old.items : []).filter(
          (row) => row.id !== item.id,
        ),
      ],
    }));
  }
  async function change(
    item: MarketStrategyHint,
    patch: Partial<
      Pick<SignalMonitor, 'enabled' | 'notifications_enabled' | 'notifications'>
    > & { deleted?: boolean },
  ) {
    if (pending.current) return false;
    pending.current = true;
    revision.current++;
    setBusy(item.id);
    try {
      const next = await pluginRequest<SignalMonitor>(
        pluginId,
        `/strategies/monitors/${item.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ revision: item.revision, ...patch }),
        },
      );
      setState((old) =>
        old.key !== key
          ? old
          : {
              key,
              items: patch.deleted
                ? old.items.filter((row) => row.id !== item.id)
                : old.items.map((row) =>
                    row.id === item.id
                      ? {
                          ...row,
                          ...next,
                          notifications:
                            next.notifications ?? row.notifications,
                        }
                      : row,
                  ),
            },
      );
      toast.success(patch.deleted ? '已移除策略提示' : '策略提示已更新');
      return true;
    } catch (error) {
      toast.error(errorText(error));
      return false;
    } finally {
      pending.current = false;
      revision.current++;
      setBusy('');
    }
  }
  return {
    items: state.key === key ? state.items : [],
    error,
    busy,
    loading,
    add,
    change,
  };
}
