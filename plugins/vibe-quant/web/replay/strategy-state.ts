import type { MarketStrategyHint } from '../../signal-types';
import type { SignalHistoryPage } from '../../signal-history';
import type { StrategyReplayFrame } from '../../replay-types';

export function replayStrategyKey(hints: readonly MarketStrategyHint[]) {
  const selected = hints.filter((hint) => hint.enabled);
  return selected.length
    ? JSON.stringify(
        selected
          .map((hint) => [hint.id, hint.config, hint.engine])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      )
    : '';
}

/** Cached causal frames restore a past portfolio without exposing later exits or protection levels. */
export function strategyAtTime(
  hint: MarketStrategyHint,
  frames: readonly StrategyReplayFrame[],
  time: number,
): SignalHistoryPage | undefined {
  const index = frames.findLastIndex((frame) => frame.time <= time);
  if (index < 0 || frames[index].time !== time) return undefined;
  const frame = frames[index];
  return {
    monitor: { ...hint, status: 'running', message: 'K 线回放' },
    summary: frame.summary,
    trades: frames
      .slice(0, index + 1)
      .flatMap((item) => item.trades)
      .reverse(),
    signals: frames
      .slice(0, index + 1)
      .flatMap((item) => item.signals)
      .reverse(),
    next: null,
    signals_next: null,
  };
}

export function replayHint(
  hint: MarketStrategyHint,
  page: SignalHistoryPage | undefined,
  frame: StrategyReplayFrame | undefined,
): MarketStrategyHint {
  return {
    ...hint,
    status: page ? 'running' : hint.enabled ? 'starting' : 'paused',
    signals: page?.signals ?? [],
    trades: [...(page?.trades ?? []), ...(page?.summary?.open_trades ?? [])],
    overlay: frame?.overlay ?? { updated_at: null, levels: [] },
  };
}
