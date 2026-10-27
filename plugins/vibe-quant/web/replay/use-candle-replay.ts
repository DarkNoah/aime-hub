import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BAR_PAGE_SIZE, type Bar } from '../../shared';
import {
  fetchReplayBars,
  parseReplayTime,
  replayError,
  replayStartIndex,
  type ReplaySource,
} from './candle-replay';
import type { ReplayStepDirection } from './step-hold';
import { replayBarEnd } from '../../replay-types';

export interface ReplaySession {
  id: number;
  bars: Bar[];
  index: number;
  startIndex: number;
  snapshotTo: number;
  hasMore: boolean;
  playing: boolean;
  notificationEpoch: number;
}

/** The keyed chart workspace owns this session and cancels it on navigation. */
export function useCandleReplay(
  source: ReplaySource,
  liveBars: Bar[],
  hasAfter: boolean,
  strategyKey = '',
) {
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [speed, setSpeed] = useState(250);
  const [retryId, setRetryId] = useState(0);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [ready, setReady] = useState<{
    id: number;
    key: string;
    through: number;
  } | null>(null);
  const readyThrough = !strategyKey
    ? Infinity
    : ready?.id === session?.id && ready?.key === strategyKey
      ? ready.through
      : -Infinity;
  const readyLimit = useRef(readyThrough);
  readyLimit.current = readyThrough;
  useEffect(() => () => request.current?.abort(), []);

  const { pluginId, path, duration, symbol } = source;
  const sessionId = session?.id;
  const cursor = session?.bars.at(-1)?.time;
  const snapshotTo = session?.snapshotTo;
  const needsMore =
    !!session?.hasMore && session.bars.length - session.index <= 20;
  useEffect(() => {
    if (
      !needsMore ||
      loading ||
      error ||
      cursor === undefined ||
      snapshotTo === undefined
    )
      return;
    const controller = new AbortController();
    void fetchReplayBars(
      { pluginId, path, duration, symbol },
      { after: cursor },
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted || generation.current !== sessionId)
          return;
        const next = data.filter((bar) => bar.time <= snapshotTo);
        const hasMore =
          data.length === BAR_PAGE_SIZE && data.at(-1)!.time < snapshotTo;
        setSession((current) =>
          current?.id === sessionId
            ? {
                ...current,
                bars: [...current.bars, ...next],
                hasMore,
                playing:
                  current.playing &&
                  (current.index < current.bars.length + next.length - 1 ||
                    hasMore),
              }
            : current,
        );
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || generation.current !== sessionId)
          return;
        const message = replayError(cause);
        setError(message);
        toast.error(message);
        setSession((current) =>
          current?.id === sessionId ? { ...current, playing: false } : current,
        );
      });
    return () => controller.abort();
  }, [
    pluginId,
    path,
    duration,
    symbol,
    needsMore,
    loading,
    error,
    cursor,
    snapshotTo,
    sessionId,
    retryId,
  ]);

  const index = session?.index;
  const playing = session?.playing ?? false;
  const canAdvance =
    !!session &&
    session.index < session.bars.length - 1 &&
    replayBarEnd(session.bars[session.index + 1].time, duration) <=
      readyThrough;
  const canRetreat =
    !!session &&
    session.index > 0 &&
    replayBarEnd(session.bars[session.index - 1].time, duration) <=
      readyThrough;
  useEffect(() => {
    if (!playing || !canAdvance || loading) return;
    const timer = window.setTimeout(() => {
      setSession((current) => {
        if (!current?.playing) return current;
        const index = Math.min(current.index + 1, current.bars.length - 1);
        return {
          ...current,
          index,
          playing: index < current.bars.length - 1 || current.hasMore,
        };
      });
    }, speed);
    return () => window.clearTimeout(timer);
  }, [playing, canAdvance, index, speed, loading]);

  async function start(value: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const id = ++generation.current;
    setLoading(true);
    setError('');
    setSession((current) =>
      current ? { ...current, playing: false } : current,
    );
    try {
      const time = parseReplayTime(value, duration);
      const [window, latest] = await Promise.all([
        fetchReplayBars(source, { around: time }, controller.signal),
        fetchReplayBars(source, { limit: 1 }, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const end = latest.at(-1)?.time ?? 0;
      const bars = window.filter((bar) => bar.time <= end);
      const index = replayStartIndex(bars, time);
      if (index < 0)
        throw new Error('所选时间之前没有可用 K 线，请选择已有历史的时间');
      if (time > end)
        throw new Error('所选时间晚于最新可用 K 线，请选择更早的时间');
      setSession({
        id,
        bars,
        index,
        startIndex: index,
        snapshotTo: end,
        hasMore: bars.at(-1)!.time < end,
        playing: false,
        notificationEpoch: 0,
      });
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = replayError(cause);
        setError(message);
        toast.error(message);
        // Keep the previous paused chart usable if a new location failed.
        setSession((current) => (current ? { ...current, id } : current));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function selectTime(time: number) {
    const bars = session?.bars ?? liveBars.map((bar) => ({ ...bar }));
    const index = replayStartIndex(bars, time);
    if (index < 0 || bars[index].time !== time) return;
    request.current?.abort();
    setSession({
      id: ++generation.current,
      bars,
      index,
      startIndex: index,
      snapshotTo:
        session?.snapshotTo ??
        Math.max(Math.floor(Date.now() / 1000), bars.at(-1)!.time),
      hasMore: session?.hasMore ?? hasAfter,
      playing: false,
      notificationEpoch: 0,
    });
    setLoading(false);
    setError('');
  }

  function exit() {
    request.current?.abort();
    ++generation.current;
    setSession(null);
    setLoading(false);
    setError('');
  }

  const replayBars = session?.bars;
  const bars = useMemo(
    () => replayBars?.slice(0, (index ?? 0) + 1),
    [replayBars, index],
  );
  const stepBy = useCallback(
    (direction: ReplayStepDirection) => {
      setSession((current) => {
        if (!current) return current;
        const index = Math.max(
          0,
          Math.min(current.index + direction, current.bars.length - 1),
        );
        if (
          replayBarEnd(current.bars[index].time, duration) > readyLimit.current
        )
          return current;
        return index === current.index && !current.playing
          ? current
          : { ...current, index, playing: false };
      });
    },
    [duration],
  );
  const markReady = useCallback((id: number, key: string, through: number) => {
    setReady((old) =>
      old?.id === id && old.key === key && old.through === through
        ? old
        : { id, key, through },
    );
  }, []);
  const pause = useCallback(
    () =>
      setSession((current) =>
        current?.playing ? { ...current, playing: false } : current,
      ),
    [],
  );
  return {
    session,
    bars: bars ?? liveBars,
    loading,
    error,
    speed,
    setSpeed,
    canAdvance,
    canRetreat,
    start,
    selectTime,
    exit,
    stepBy,
    markReady,
    pause,
    waitingForStrategy:
      !!session &&
      !!strategyKey &&
      replayBarEnd(
        session.bars[Math.min(session.index + 1, session.bars.length - 1)].time,
        duration,
      ) > readyThrough,
    atEnd:
      !!session &&
      session.index === session.bars.length - 1 &&
      !session.hasMore,
    seekTime: (time: number) => {
      if (!session) return false;
      const index = replayStartIndex(session.bars, time);
      if (index < 0 || time > session.bars.at(-1)!.time) return false;
      setSession({
        ...session,
        index,
        playing: false,
        notificationEpoch: session.notificationEpoch + 1,
      });
      return true;
    },
    toggle: () =>
      setSession((current) =>
        current ? { ...current, playing: !current.playing } : current,
      ),
    restart: () =>
      setSession((current) =>
        current
          ? {
              ...current,
              index: current.startIndex,
              playing: false,
              notificationEpoch: current.notificationEpoch + 1,
            }
          : current,
      ),
    retry: () => {
      setError('');
      setRetryId((value) => value + 1);
    },
  };
}
