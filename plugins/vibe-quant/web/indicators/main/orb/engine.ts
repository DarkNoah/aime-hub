// TypeScript adaptation of source.pine, © fluxchart.
// This Source Code Form is subject to the Mozilla Public License, v. 2.0.
// https://mozilla.org/MPL/2.0/
import type { Bar } from '../../../../shared';
import { movingAverage, priceValues } from '../../calculations';
import type { IndicatorOverlay } from '../../types';
import { orbDisplay } from './display';
import { timeMinutes, type OrbSettings } from './settings';

export interface OrbBreakout {
  bullish: boolean;
  startIndex: number;
  endIndex?: number;
  failed: boolean;
  retests: number;
}

export interface OrbSession {
  high: number;
  low: number;
  startTime: number;
  startIndex: number;
  endIndex?: number;
  state:
    'Opening Range' | 'Waiting For Breakouts' | 'In Breakout' | 'Entry Taken';
  breakouts: OrbBreakout[];
  entryIndex?: number;
  entryPrice?: number;
  entryBullish?: boolean;
  entryATR?: number;
  targets: { index: number; price: number }[];
  slIndex?: number;
  slPrice?: number;
}

export interface OrbEvent {
  index: number;
  type: 'Buy' | 'Sell' | 'TP 1' | 'TP 2' | 'TP 3' | 'SL' | 'Exit';
  session: OrbSession;
}

export interface OrbResult extends IndicatorOverlay {
  sessions: OrbSession[];
  events: OrbEvent[];
  ema: (number | undefined)[];
  atr: (number | undefined)[];
}

/** Wilder ATR(12), seeded with 12 true ranges; EMA uses HL2, not close. */
export function orbFeatures(bars: readonly Bar[], length: number) {
  const ema = movingAverage(priceValues(bars, 'hl2'), length, 'ema');
  let seed = 0;
  let count = 0;
  let value: number | undefined;
  const atr = bars.map((bar, index) => {
    const previous = bars[index - 1];
    const tr = previous
      ? Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - previous.close),
          Math.abs(bar.low - previous.close),
        )
      : bar.high - bar.low;
    if (!Number.isFinite(tr)) {
      seed = 0;
      count = 0;
      value = undefined;
      return undefined;
    }
    if (value !== undefined) value = (value * 11 + tr) / 12;
    else {
      seed += tr;
      count++;
      if (count === 12) value = seed / 12;
    }
    return value;
  });
  return { ema, atr };
}

export const profitPercent = (value: number, reference: number) =>
  (Math.abs(value - reference) / reference) * 100;

function sessionKey(time: number, startMinutes: number): number {
  const offset = startMinutes * 60 - 8 * 3600;
  return Math.floor((time - offset) / 86400) * 86400 + offset;
}

function beginsSession(
  bars: readonly Bar[],
  index: number,
  settings: OrbSettings,
): boolean {
  const time = bars[index].time;
  if (!settings.customSessionEnabled) {
    return time === sessionKey(time, timeMinutes(settings.regularSessionStart));
  }
  const start = timeMinutes(settings.customSessionStart);
  const span =
    ((timeMinutes(settings.customSessionEnd) - start + 1440) % 1440 || 1440) *
    60;
  const key = sessionKey(time, start);
  if (time >= key + span) return false;
  const previousTime = bars[index - 1]?.time;
  return (
    previousTime === undefined ||
    previousTime < key ||
    previousTime >= key + span
  );
}

export function calculateOrb(
  bars: readonly Bar[],
  settings: OrbSettings,
  duration: number,
): OrbResult {
  const sessions: OrbSession[] = [];
  const events: OrbEvent[] = [];
  const warnings: string[] = [];
  const { ema, atr } = orbFeatures(bars, Number(settings.emaLength));
  if (!Number.isSafeInteger(duration) || duration < 60 || duration > 900) {
    return {
      sessions,
      events,
      ema,
      atr,
      drawings: [],
      warnings: ['ORB Algo：仅支持不大于 15 分钟的分钟 K 线，请切换周期。'],
      dashboards: [],
    };
  }
  const retestsNeeded = { High: 0, Medium: 1, Low: 2, Lowest: 3 }[
    settings.sensitivity
  ];
  let current: OrbSession | undefined;
  // The source guard excludes bar_index == 0. Features still include it.
  for (let index = 1; index < bars.length; index++) {
    const bar = bars[index];
    if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
      continue;
    if (beginsSession(bars, index, settings)) {
      if (current) {
        current.endIndex = index - 1;
        if (current.entryIndex !== undefined && current.slIndex === undefined) {
          current.slPrice = bars[index - 1].close;
          current.slIndex = index - 1;
          events.push({ index: index - 1, type: 'Exit', session: current });
        }
      }
      current = {
        high: 0,
        low: bar.low,
        startTime: bar.time,
        startIndex: index,
        state: 'Opening Range',
        breakouts: [],
        targets: [],
      };
      sessions.push(current);
    }
    if (!current) continue;
    const orb = current;
    if (orb.state === 'Opening Range') {
      if (bar.time < orb.startTime + settings.rangeMinutes * 60) {
        orb.high = Math.max(orb.high, bar.high);
        orb.low = Math.min(orb.low, bar.low);
      } else orb.state = 'Waiting For Breakouts';
    }
    if (orb.state === 'Waiting For Breakouts') {
      const price =
        settings.breakoutCondition === 'EMA' ? ema[index] : bar.close;
      if (price !== undefined && (price > orb.high || price < orb.low)) {
        orb.breakouts.push({
          bullish: price > orb.high,
          startIndex: index,
          retests: 0,
          failed: false,
        });
        orb.state = 'In Breakout';
      }
    }
    if (orb.state === 'In Breakout') {
      const breakout = orb.breakouts.at(-1)!;
      if (breakout.bullish ? bar.close < orb.high : bar.close > orb.low) {
        breakout.failed = true;
        breakout.endIndex = index;
        orb.state = 'Waiting For Breakouts';
      }
      if (
        index > breakout.startIndex &&
        (breakout.bullish
          ? bar.close > orb.high && bar.low < orb.high
          : bar.close < orb.low && bar.high > orb.low)
      )
        breakout.retests++;
      // Preserve the source's independent condition: High can enter on a
      // failed EMA breakout bar because zero retests are already sufficient.
      if (breakout.retests >= retestsNeeded) {
        breakout.endIndex = index;
        orb.state = 'Entry Taken';
        orb.entryIndex = index;
        orb.entryPrice = bar.close;
        orb.entryBullish = breakout.bullish;
        orb.entryATR = atr[index];
        const center = (orb.high + orb.low) / 2;
        orb.slPrice =
          settings.slMethod === 'Balanced'
            ? center
            : settings.slMethod === 'Safer'
              ? (center + (breakout.bullish ? orb.high : orb.low)) / 2
              : (center + (breakout.bullish ? orb.low : orb.high)) / 2;
        events.push({
          index,
          type: breakout.bullish ? 'Buy' : 'Sell',
          session: orb,
        });
      }
    }
    if (orb.state !== 'Entry Taken' || orb.slIndex !== undefined) continue;
    const direction = orb.entryBullish ? 1 : -1;
    const entry = orb.entryPrice!;
    const targetIndex = orb.targets.length;
    let targetPrice: number | undefined;
    if (targetIndex < 3) {
      if (settings.tpMethod === 'ATR' && orb.entryATR !== undefined) {
        const price =
          entry + orb.entryATR * [0.75, 1.5, 2.25][targetIndex] * direction;
        if (orb.entryBullish ? bar.high >= price : bar.low <= price)
          targetPrice = price;
      } else if (settings.tpMethod === 'Dynamic') {
        const value = ema[index];
        if (
          value !== undefined &&
          direction * (value - entry) > 0 &&
          profitPercent(value, entry) >= 0.2 &&
          direction * (bar.close - value) < 0
        ) {
          const previousTarget = orb.targets.at(-1);
          if (
            !previousTarget ||
            (direction * (value - previousTarget.price) > 0 &&
              profitPercent(value, previousTarget.price) >= 0.075)
          )
            targetPrice = value;
        }
      }
    }
    if (targetPrice !== undefined) {
      orb.targets.push({ index, price: targetPrice });
      events.push({
        index,
        type: (['TP 1', 'TP 2', 'TP 3'] as const)[targetIndex],
        session: orb,
      });
      if (targetIndex === 0 && settings.adaptiveSL) orb.slPrice = entry;
      if (targetIndex === 2) orb.slIndex = -1;
    }
    // At most one TP per candle, and a TP suppresses SL on that candle.
    if (
      targetPrice === undefined &&
      orb.slPrice !== undefined &&
      (orb.entryBullish ? bar.low < orb.slPrice : bar.high > orb.slPrice)
    ) {
      orb.slIndex = index;
      events.push({ index, type: 'SL', session: orb });
    }
  }
  if (bars.length && !sessions.length)
    warnings.push(
      'ORB Algo：尚未加载时段起点，请向左加载开盘前的 K 线，或检查北京时间的时段设置。',
    );
  if (
    sessions.some(
      (orb) => orb.entryIndex !== undefined && orb.entryATR === undefined,
    )
  )
    warnings.push(
      'ORB Algo：部分入场缺少 ATR(12) 预热，无法显示对应 ATR 目标价。',
    );
  const result = { sessions, events, ema, atr, warnings };
  return { ...result, ...orbDisplay(bars, settings, result) };
}
