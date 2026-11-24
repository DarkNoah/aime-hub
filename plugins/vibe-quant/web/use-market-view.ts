import { useEffect, useState } from 'react';
import { randomUUID } from '@aime/shared/uuid';
import { pluginRequest } from '@app/plugin-sdk/web';
import type { Instrument } from '../shared';

interface MarketView {
  instrument: Instrument;
  mode: 'live' | 'history' | 'limit';
  availableDurations?: number[];
}

export function useMarketView(
  pluginId: string,
  symbol: string,
  retry: number,
  engine?: string,
) {
  const [result, setResult] = useState<{
    key: string;
    view?: MarketView;
    error?: string;
  }>();
  const [restored, setRestored] = useState(0);
  const key = JSON.stringify([pluginId, engine, symbol, retry, restored]);
  useEffect(() => {
    if (!symbol) return;
    const path = `/market-view/${randomUUID()}`;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let historical = false;
    function release() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      if (historical) return;
      void pluginRequest(
        pluginId,
        path + '?symbol=' + encodeURIComponent(symbol),
        { method: 'DELETE', keepalive: true },
      ).catch(() => {});
    }
    async function retain() {
      let interval = 45000;
      try {
        const view = await pluginRequest<MarketView>(pluginId, path, {
          method: 'POST',
          body: JSON.stringify({ symbol }),
          signal: AbortSignal.timeout(15000),
        });
        historical = view.mode === 'history';
        if (!disposed) setResult({ key, view });
        if (historical) return;
        if (view.mode === 'limit') interval = 10000;
      } catch (error) {
        interval = 10000;
        if (!disposed)
          setResult((previous) => ({
            key,
            view: previous?.key === key ? previous.view : undefined,
            error:
              error instanceof Error ? error.message : 'MARKET_VIEW_FAILED',
          }));
      }
      if (!disposed)
        timer = setTimeout(() => {
          void retain();
        }, interval);
    }
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setRestored((value) => value + 1);
    };
    void retain();
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', restore);
      // Closing fences late opens on the server. Restoring a page gets a new ID.
      release();
    };
  }, [pluginId, symbol, key]);
  return result?.key === key ? result : undefined;
}
