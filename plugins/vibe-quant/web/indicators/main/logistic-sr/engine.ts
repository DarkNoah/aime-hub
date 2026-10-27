// TypeScript adaptation of the user-supplied source.pine, © fluxchart.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Bar } from '../../../../shared';
import type { IndicatorDrawing, IndicatorOverlay } from '../../types';
import type { LogisticSrSettings } from './settings';

const LEARNING_RATE = 0.008;
const RETEST_COOLDOWN = 3;
const DRAWING_LIMIT = 500;

export interface LogisticSrLevel {
  isSupport: boolean;
  level: number;
  startIndex: number;
  confirmedIndex: number;
  endIndex?: number;
  timesRespected: number;
  detectedRSI: number;
  detectedBodySize: number;
  detectedPrediction: number;
  detectedByRegression: boolean;
  latestRetestIndex: number;
}

export interface LogisticSrEvent {
  index: number;
  type: 'retest' | 'break';
  level: LogisticSrLevel;
}

export interface LogisticSrResult extends IndicatorOverlay {
  levels: LogisticSrLevel[];
  events: LogisticSrEvent[];
}

/** Wilder averages: ATR seeds with N true ranges, RSI with N close changes. */
export function logisticSrFeatures(bars: readonly Bar[], length: number) {
  const rsi: number[] = [];
  const atr: number[] = [];
  let range = 0,
    gain = 0,
    loss = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const previous = bars[i - 1];
    const tr = previous
      ? Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - previous.close),
          Math.abs(bar.low - previous.close),
        )
      : bar.high - bar.low;
    if (i < length) range += tr / length;
    else range = (range * (length - 1) + tr) / length;
    atr.push(i >= length - 1 ? range : NaN);
    if (previous) {
      const change = bar.close - previous.close;
      if (i <= length) {
        gain += Math.max(change, 0) / length;
        loss += Math.max(-change, 0) / length;
      } else {
        gain = (gain * (length - 1) + Math.max(change, 0)) / length;
        loss = (loss * (length - 1) + Math.max(-change, 0)) / length;
      }
    }
    // Pine's nz(ta.rsi(...), 0), including an entirely flat warm-up.
    rsi.push(
      i < length || (gain === 0 && loss === 0)
        ? 0
        : loss === 0
          ? 100
          : 100 - 100 / (1 + gain / loss),
    );
  }
  return { rsi, atr };
}

function sigmoid(value: number) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function predict(
  levels: readonly LogisticSrLevel[],
  candidate: LogisticSrLevel,
  targetRespects: number,
) {
  let rsiBias = 1,
    bodyBias = 1;
  for (const level of levels) {
    // Preserve the source's -1 / +1 labels and (p + loss) update, not
    // conventional logistic-regression gradient descent. Bias stays at 1.
    const y = level.timesRespected >= targetRespects ? 1 : -1;
    const z =
      1 + rsiBias * level.detectedRSI + bodyBias * level.detectedBodySize;
    const p = sigmoid(z);
    // Algebraically equal to -y*log(p)-(1-y)*log(1-p), without log(0).
    const loss = Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - y * z;
    rsiBias -= LEARNING_RATE * (p + loss) * level.detectedRSI;
    bodyBias -= LEARNING_RATE * (p + loss) * level.detectedBodySize;
  }
  return sigmoid(
    1 + rsiBias * candidate.detectedRSI + bodyBias * candidate.detectedBodySize,
  );
}

function isPivot(
  bars: readonly Bar[],
  index: number,
  length: number,
  isSupport: boolean,
) {
  const key = isSupport ? 'low' : 'high';
  const value = bars[index][key];
  // Equal extremes on the right postpone confirmation to the last occurrence.
  for (let offset = 1; offset <= length; offset++) {
    const right = bars[index + offset][key];
    const left = bars[index - offset][key];
    if (
      isSupport
        ? right <= value || left < value
        : right >= value || left > value
    )
      return false;
  }
  return true;
}

/** Replay loaded bars so candle revisions/prepended history never leave stale levels. */
export function calculateLogisticSr(
  bars: readonly Bar[],
  settings: LogisticSrSettings,
): LogisticSrResult {
  const levels: LogisticSrLevel[] = [];
  const events: LogisticSrEvent[] = [];
  const drawings: IndicatorDrawing[] = [];
  const result: LogisticSrResult = { levels, events, drawings, warnings: [] };
  const length = settings.pivotLength;
  if (!Number.isSafeInteger(length) || length < 1) {
    result.warnings!.push('逻辑回归支撑阻力：拐点确认长度必须为正整数。');
    return result;
  }
  if (bars.length < length * 2 + 1) {
    result.warnings!.push(
      `逻辑回归支撑阻力：至少需要 ${length * 2 + 1} 根 K 线确认拐点。`,
    );
    return result;
  }
  if (
    bars.some(
      (bar) => ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite),
    )
  ) {
    result.warnings!.push('逻辑回归支撑阻力：K 线价格不完整，暂不计算。');
    return result;
  }
  const { rsi, atr } = logisticSrFeatures(bars, length);
  const supports: LogisticSrLevel[] = [],
    resistances: LogisticSrLevel[] = [];
  let active: LogisticSrLevel[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (i >= length * 2) {
      const index = i - length;
      for (const isSupport of [false, true]) {
        if (!isPivot(bars, index, length, isSupport)) continue;
        const pivot = bars[index];
        const level: LogisticSrLevel = {
          isSupport,
          level: isSupport ? pivot.low : pivot.high,
          startIndex: index,
          confirmedIndex: i,
          timesRespected: 0,
          detectedRSI: rsi[index] > 50 ? 1 : -1,
          // The source compares the pivot body to ATR on the confirmation bar.
          detectedBodySize:
            Math.abs(pivot.close - pivot.open) > atr[i] ? 1 : -1,
          detectedPrediction: 0,
          detectedByRegression: false,
          latestRetestIndex: 0,
        };
        const training = isSupport ? supports : resistances;
        training.push(level); // The source includes the new pivot in training.
        level.detectedPrediction = predict(
          training,
          level,
          settings.targetRespects,
        );
        level.detectedByRegression =
          level.detectedPrediction >= settings.probabilityThreshold;
        levels.push(level);
        active.push(level);
      }
    }
    // All levels (even rejected or later broken ones) retain their observed
    // respect count for future training. Only active levels need price checks.
    active = active.filter((level) => {
      const crossed = level.isSupport
        ? bar.low < level.level
        : bar.high > level.level;
      if (!crossed) return true;
      const respected = level.isSupport
        ? bar.close > level.level
        : bar.close < level.level;
      if (respected) {
        if (
          level.detectedByRegression &&
          i > level.latestRetestIndex + RETEST_COOLDOWN
        ) {
          level.latestRetestIndex = i;
          events.push({ index: i, type: 'retest', level });
        }
        level.timesRespected++;
        return true;
      }
      level.endIndex = i;
      if (level.detectedByRegression)
        events.push({ index: i, type: 'break', level });
      return false;
    });
  }

  const last = bars.length - 1;
  const visible = levels
    .filter(
      (level) =>
        level.detectedByRegression &&
        !(
          settings.hideFarLines &&
          level.endIndex === undefined &&
          Math.abs(bars[last].close - level.level) > atr[last] * 7
        ),
    )
    .slice(-DRAWING_LIMIT);
  const probabilityCount = settings.showPredictionLabels ? visible.length : 0;
  const labelBudget = DRAWING_LIMIT - probabilityCount;
  const visibleEvents = events.filter((event) =>
    event.type === 'retest' ? settings.showRetests : settings.showBreaks,
  );
  // Match Pine's separate 500-line / 500-label display budgets, keeping recent
  // event markers. Capping display never truncates the regression history.
  for (const event of labelBudget > 0
    ? visibleEvents.slice(-labelBudget)
    : []) {
    const support = event.level.isSupport;
    const retest = event.type === 'retest';
    const below = retest ? support : !support;
    const price = below ? bars[event.index].low : bars[event.index].high;
    drawings.push({
      id: `sr-${event.level.startIndex}-${support}-${event.type}-${event.index}`,
      kind: 'label',
      from: event.index,
      to: event.index,
      top: price,
      bottom: price,
      color: retest
        ? support
          ? settings.textColorSupport
          : settings.textColorResistance
        : '#ffffff',
      labelBackground: retest
        ? support
          ? settings.supportColor
          : settings.resistanceColor
        : '#2196f3',
      text: retest ? 'R' : 'B',
      align: below ? 'below' : 'above',
      size: 'tiny',
    });
  }
  for (const level of visible) {
    drawings.push({
      id: `sr-${level.startIndex}-${level.isSupport}`,
      kind: 'line',
      from: level.startIndex,
      to: level.endIndex ?? last,
      top: level.level,
      bottom: level.level,
      color: level.isSupport ? settings.supportColor : settings.resistanceColor,
      style: settings.lineStyle,
      lineWidth: settings.lineWidth,
      text: settings.showPredictionLabels
        ? `${(level.detectedPrediction * 100).toFixed(2)}%`
        : undefined,
      labelIndex:
        level.endIndex === undefined
          ? last
          : Math.floor((level.startIndex + level.endIndex) / 2),
      align: level.isSupport ? 'below' : 'above',
      size: 'small',
    });
  }
  return result;
}
