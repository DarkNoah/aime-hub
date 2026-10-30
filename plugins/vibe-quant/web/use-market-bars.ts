import { useEffect, useRef, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import { toast } from 'sonner';
import { BAR_PAGE_SIZE, type Bar, type BarWindow } from '../shared';
import { intradayBars } from './chart-period';
import { mergeBars, type PageDirection } from './chart-navigation';

interface BarsView {
  identity: string;
  bars: Bar[];
  loading: boolean;
  error: string;
  beforeLoading: boolean;
  afterLoading: boolean;
  hasBefore: boolean;
  hasAfter: boolean;
  historical: boolean;
  windowRevision: number;
  targetTime: number | null;
  priceTick?: number;
}

const emptyView = (identity: string): BarsView => ({
  identity,
  bars: [],
  loading: true,
  error: '',
  beforeLoading: false,
  afterLoading: false,
  hasBefore: true,
  hasAfter: false,
  historical: false,
  windowRevision: 0,
  targetTime: null,
});

interface Session {
  view: BarsView;
  url: string;
  dailyUrl: string;
  revision: number;
  disposed: boolean;
  navigating: boolean;
  requests: Set<AbortController>;
}

export function useMarketBars({
  pluginId,
  symbol,
  duration,
  intraday,
  identity,
  retry,
  barsPath,
  initialTime = null,
  live = true,
}: {
  pluginId: string;
  symbol: string;
  duration: number;
  intraday: boolean;
  identity: string;
  retry: number;
  /** An authorized backtest uses the same history reader without a watchlist entry. */
  barsPath?: string;
  initialTime?: number | null;
  live?: boolean;
}) {
  const [view, setView] = useState(() => emptyView(identity));
  const session = useRef<Session | null>(null);
  const focus = useRef(initialTime);

  function commit(active: Session, changes: Partial<BarsView>) {
    if (active.disposed) return;
    active.view = { ...active.view, ...changes };
    setView(active.view);
  }

  async function request<T>(active: Session, url: string): Promise<T> {
    const controller = new AbortController();
    active.requests.add(controller);
    try {
      return await pluginRequest<T>(pluginId, url, {
        signal: controller.signal,
      });
    } finally {
      active.requests.delete(controller);
    }
  }

  useEffect(() => {
    const path = barsPath ?? `/bars?symbol=${encodeURIComponent(symbol)}`;
    const url = `${path}${path.includes('?') ? '&' : '?'}`;
    const active: Session = {
      view: emptyView(identity),
      url: `${url}duration=${duration}`,
      dailyUrl: `${url}duration=86400`,
      revision: 0,
      disposed: false,
      navigating: false,
      requests: new Set(),
    };
    session.current = active;
    commit(active, { loading: !!symbol });
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const revision = active.revision;
      if (!active.navigating && !active.view.historical) {
        try {
          const [data, daily] = await Promise.all([
            request<Bar[]>(
              active,
              `${active.url}&limit=${intraday ? 1000 : BAR_PAGE_SIZE}`,
            ),
            intraday
              ? request<Bar[]>(active, active.dailyUrl)
              : Promise.resolve([] as Bar[]),
          ]);
          if (!active.disposed && revision === active.revision) {
            commit(active, {
              bars: intraday
                ? intradayBars(data, daily)
                : mergeBars(active.view.bars, data),
              ...(!active.view.bars.length
                ? { hasBefore: data.length === BAR_PAGE_SIZE }
                : {}),
              loading: false,
              error: '',
            });
          }
        } catch {
          if (!active.disposed && revision === active.revision)
            commit(active, {
              loading: false,
              error: intraday
                ? '分时行情读取失败，正在重试'
                : 'K 线读取失败，正在重试',
            });
        }
      }
      if (!active.disposed && live)
        timer = setTimeout(() => void poll(), document.hidden ? 10000 : 3000);
    }
    if (symbol) {
      if (initialTime !== null && focus.current !== null) {
        commit(active, { historical: true });
        void navigate(focus.current);
      }
      void poll();
    }
    return () => {
      active.disposed = true;
      for (const controller of active.requests) controller.abort();
      clearTimeout(timer);
    };
    // Each identity owns its requests, pagination and polling lifetime.
  }, [
    pluginId,
    symbol,
    duration,
    intraday,
    identity,
    retry,
    barsPath,
    initialTime,
    live,
  ]);

  function current() {
    const active = session.current;
    return active && !active.disposed && active.view.identity === identity
      ? active
      : null;
  }

  async function navigate(time: number | null): Promise<boolean> {
    const active = current();
    if (!active) return false;
    const revision = ++active.revision;
    active.navigating = true;
    focus.current = time;
    for (const controller of active.requests) controller.abort();
    commit(active, {
      loading: true,
      beforeLoading: false,
      afterLoading: false,
      error: '',
    });
    try {
      const result: BarWindow =
        time !== null && intraday
          ? await intradayWindow(active, time)
          : time === null
            ? {
                bars: await request<Bar[]>(
                  active,
                  `${active.url}&limit=${BAR_PAGE_SIZE}`,
                ),
                targetTime: null,
              }
            : await request<BarWindow>(active, `${active.url}&around=${time}`);
      if (active.disposed || revision !== active.revision) return false;
      if (!result.bars.length) {
        toast.error('该标的暂无可用 K 线');
        return false;
      }
      commit(active, {
        bars: result.bars,
        targetTime: result.targetTime,
        historical: time !== null,
        hasBefore: !intraday,
        hasAfter: !intraday && time !== null,
        priceTick: result.priceTick ?? active.view.priceTick,
        windowRevision: active.view.windowRevision + 1,
      });
      return true;
    } catch {
      if (!active.disposed && revision === active.revision) {
        commit(active, { error: '行情跳转失败，请重试' });
        toast.error('行情跳转失败，请重试');
      }
      return false;
    } finally {
      if (!active.disposed && revision === active.revision) {
        active.navigating = false;
        commit(active, { loading: false });
      }
    }
  }

  async function intradayWindow(
    active: Session,
    time: number,
  ): Promise<BarWindow> {
    const daily = await request<BarWindow>(
      active,
      `${active.dailyUrl}&around=${time}`,
    );
    const day = daily.bars.findLast((bar) => bar.time <= time) ?? daily.bars[0];
    if (!day) return { bars: [], targetTime: null };
    const end = daily.bars.find((bar) => bar.time > day.time)?.time;
    const minutes = await request<Bar[]>(
      active,
      `${active.url}&after=${day.time - 1}&limit=1000`,
    );
    const bars = minutes.filter((bar) => end === undefined || bar.time < end);
    return {
      bars,
      targetTime:
        bars.findLast((bar) => bar.time <= time)?.time ?? bars[0]?.time ?? null,
      priceTick: daily.priceTick,
    };
  }

  async function loadMore(direction: PageDirection) {
    const active = current();
    if (!active || intraday || active.navigating || !active.view.bars.length)
      return;
    const loadingKey =
      direction === 'before' ? 'beforeLoading' : 'afterLoading';
    const hasKey = direction === 'before' ? 'hasBefore' : 'hasAfter';
    if (active.view[loadingKey] || !active.view[hasKey]) return;
    const cursor =
      direction === 'before' ? active.view.bars[0] : active.view.bars.at(-1)!;
    const revision = active.revision;
    commit(active, { [loadingKey]: true });
    try {
      const data = await request<Bar[]>(
        active,
        `${active.url}&${direction}=${cursor.time}&limit=${BAR_PAGE_SIZE}`,
      );
      if (active.disposed || revision !== active.revision) return;
      commit(active, {
        bars: mergeBars(active.view.bars, data),
        [hasKey]: data.length === BAR_PAGE_SIZE,
        // Once the forward page reaches the live tail, polling can safely resume.
        ...(live && direction === 'after' && data.length < BAR_PAGE_SIZE
          ? { historical: false }
          : {}),
      });
    } catch {
      if (!active.disposed && revision === active.revision)
        toast.error('读取历史行情失败，请再次拖动或点击重试');
    } finally {
      if (!active.disposed && revision === active.revision)
        commit(active, { [loadingKey]: false });
    }
  }

  return {
    ...(view.identity === identity ? view : emptyView(identity)),
    replaySource: {
      pluginId,
      symbol,
      duration,
      path: barsPath ?? `/bars?symbol=${encodeURIComponent(symbol)}`,
    },
    navigate,
    loadMore,
  };
}
