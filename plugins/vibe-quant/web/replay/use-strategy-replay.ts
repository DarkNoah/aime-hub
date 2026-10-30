import { useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from '@aime/shared/uuid';
import { pluginRequest } from '@app/plugin-sdk/web';
import type { MarketStrategyHint } from '../../signal-types';
import type { SignalHistoryPage } from '../../signal-history';
import {
  replayBarEnd,
  type StrategyReplayBatch,
  type StrategyReplayFrame,
} from '../../replay-types';
import type { ReplaySession } from './use-candle-replay';
import { replayHint, strategyAtTime } from './strategy-state';

interface Calculation {
  key: string;
  token: string;
  abort: AbortController;
  frames: Map<string, StrategyReplayFrame[]>;
  busy: boolean;
  error: string;
  expired: boolean;
}
const messages: Record<string, string> = {
  SCRIPT_EXECUTION_ADMIN_REQUIRED: '策略回放需要管理员权限',
  REPLAY_STRATEGY_UNAVAILABLE: '策略已停用或归档，请调整所选策略后重新回放',
  REPLAY_CONFIG_CHANGED: '策略配置已变更，请重新定位回放',
  REPLAY_SESSION_LIMIT: '回放会话过多，请关闭其他回放后重试',
  REPLAY_FRAME_LIMIT: '本次策略回放已达到 20,000 根，请重新定位起点',
  REPLAY_FRAME_EXPIRED: '策略回放会话已过期，重试后会恢复到当前 K 线',
  REPLAY_BUSY: '策略正在完成上一批计算，请稍后重试',
  TQ_INTERACTIVE_REPLAY_UNSUPPORTED:
    '天勤模拟使用已保存的历史成交；暂不支持交互式重新计算，请退出 K 线回放查看历史记录',
  REPLAY_FAILED: '策略回放计算失败，请检查行情数据和策略后重试',
};
export interface StrategyReplayView {
  items: MarketStrategyHint[];
  pages: Record<string, SignalHistoryPage>;
  pending: boolean;
  error: string;
  through: number;
  retry: () => void;
  navigate: (time: number) => Promise<boolean>;
}

export function useStrategyReplay({
  pluginId,
  session,
  duration,
  hints,
  strategyKey,
  markReady,
  pause,
}: {
  pluginId: string;
  session: ReplaySession | null;
  duration: number;
  hints: readonly MarketStrategyHint[];
  strategyKey: string;
  markReady: (id: number, key: string, through: number) => void;
  pause: () => void;
}) {
  const [generation, setGeneration] = useState(0);
  const key = session ? `${session.id}:${generation}:${strategyKey}` : '';
  const active = useRef<Calculation | null>(null);
  const [revision, setRevision] = useState(0);
  const [failure, setFailure] = useState({ key: '', message: '' });
  const selected = hints.filter((hint) => hint.enabled);
  const ids = selected
    .map((hint) => hint.id)
    .sort()
    .join(',');
  const currentTime = session
    ? replayBarEnd(session.bars[session.index].time, duration)
    : 0;
  useEffect(() => {
    if (!key || !ids) {
      active.current = null;
      return;
    }
    const calculation: Calculation = {
      key,
      token: randomUUID(),
      abort: new AbortController(),
      frames: new Map(),
      busy: false,
      error: '',
      expired: false,
    };
    active.current = calculation;
    setRevision((value) => value + 1);
    return () => {
      calculation.abort.abort();
      for (const id of ids.split(','))
        void pluginRequest(
          pluginId,
          `/strategies/monitors/${id}/replay/${calculation.token}`,
          { method: 'DELETE', keepalive: true },
        ).catch(() => {});
    };
  }, [key, ids, pluginId]);

  useEffect(() => {
    const calculation = active.current;
    if (
      !session ||
      !calculation ||
      calculation.key !== key ||
      calculation.busy ||
      calculation.error
    )
      return;
    const through = Math.min(
      ...ids
        .split(',')
        .map((id) => calculation.frames.get(id)?.at(-1)?.time ?? 0),
    );
    const refillAt = replayBarEnd(
      session.bars[Math.min(session.index + 20, session.bars.length - 1)].time,
      duration,
    );
    if (through >= refillAt) return;
    const times = session.bars
      .slice(0, session.index + 201)
      .map((bar) => replayBarEnd(bar.time, duration))
      .filter((time) => time > through)
      .slice(0, 200);
    if (!times.length) return;
    calculation.busy = true;
    void Promise.all(
      ids.split(',').map(async (id) => {
        const result = await pluginRequest<StrategyReplayBatch>(
          pluginId,
          `/strategies/monitors/${id}/replay`,
          {
            method: 'POST',
            signal: calculation.abort.signal,
            body: JSON.stringify({
              session: calculation.token,
              from: session.bars[0].time,
              after: through || undefined,
              times,
            }),
          },
        );
        if (
          result.frames.length !== times.length ||
          result.frames.some((frame, index) => frame.time !== times[index])
        )
          throw new Error('回放策略进度不匹配，请重新定位');
        return { id, result };
      }),
    )
      .then((results) => {
        if (calculation.abort.signal.aborted) return;
        for (const { id, result } of results) {
          const old = calculation.frames.get(id) ?? [];
          const first = result.frames[0].time;
          calculation.frames.set(id, [
            ...old.filter((frame) => frame.time < first),
            ...result.frames,
          ]);
        }
        setFailure({ key, message: '' });
      })
      .catch((cause: unknown) => {
        if (calculation.abort.signal.aborted) return;
        const code = cause instanceof Error ? cause.message : '';
        calculation.error = messages[code] ?? '策略回放计算失败，请重试';
        calculation.expired = code === 'REPLAY_FRAME_EXPIRED';
        setFailure({ key, message: calculation.error });
        pause();
      })
      .finally(() => {
        calculation.busy = false;
        if (!calculation.abort.signal.aborted)
          setRevision((value) => value + 1);
      });
  }, [key, ids, pluginId, session, duration, revision, pause]);

  const result = useMemo(() => {
    const calculation = active.current?.key === key ? active.current : null;
    const pages: Record<string, SignalHistoryPage> = {};
    const items = hints.map((hint) => {
      const frames = hint.enabled
        ? (calculation?.frames.get(hint.id) ?? [])
        : [];
      const page = strategyAtTime(hint, frames, currentTime);
      if (page) pages[hint.id] = page;
      return replayHint(
        hint,
        page,
        frames.find((frame) => frame.time === currentTime),
      );
    });
    const through = ids
      ? Math.min(
          ...ids
            .split(',')
            .map((id) => calculation?.frames.get(id)?.at(-1)?.time ?? 0),
        )
      : Infinity;
    return { pages, items, through, pending: !!ids && through < currentTime };
  }, [key, hints, currentTime, ids, revision]);
  useEffect(() => {
    if (session) markReady(session.id, strategyKey, result.through);
  }, [session?.id, strategyKey, result.through, markReady]);
  return {
    ...result,
    error: failure.key === key ? failure.message : '',
    retry: () => {
      if (active.current?.key === key && active.current.expired) {
        setGeneration((value) => value + 1);
        return;
      }
      if (active.current?.key === key) active.current.error = '';
      setFailure({ key, message: '' });
      setRevision((value) => value + 1);
    },
  };
}
