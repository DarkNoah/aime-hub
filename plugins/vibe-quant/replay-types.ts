import type { SignalOverlay, StrategySignal } from './signal-types.js';
import type { OpenTrade, Trade } from './strategy-types.js';
import { MONTH_DURATION } from './shared.js';
import type { SignalHistorySummary } from './signal-history.js';

/** Each frame is captured after processing only events available at this cutoff. */
export interface StrategyReplayFrame {
  time: number;
  signals: StrategySignal[];
  trades: Trade[];
  positions: OpenTrade[];
  overlay: SignalOverlay;
  summary: SignalHistorySummary;
}
export interface StrategyReplayBatch {
  frames: StrategyReplayFrame[];
  through: number;
}

export function replayBarEnd(time: number, duration: number) {
  if (duration !== MONTH_DURATION) return time + duration;
  const date = new Date((time + 8 * 3600) * 1000);
  return (
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000 - 8 * 3600
  );
}
