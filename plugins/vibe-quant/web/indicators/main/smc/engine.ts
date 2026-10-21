// Adapted from analysis/smc.pine, © LuxAlgo, CC BY-NC-SA 4.0.
// https://creativecommons.org/licenses/by-nc-sa/4.0/
import type { Bar } from '../../../../shared';
import type { IndicatorDrawing } from '../../types';

export type SmcBar = Pick<Bar, 'time' | 'open' | 'high' | 'low' | 'close'> & {
  isFinal?: boolean;
};
type Candle = SmcBar;
import { normalizeSmcSettings, type SmcSettings } from './settings';

export type SmcDrawing = IndicatorDrawing;
export interface SmcEvent {
  time: number;
  index: number;
  type: string;
  provisional: boolean;
}
export interface SmcResult {
  drawings: SmcDrawing[];
  events: SmcEvent[];
  candleColors: (string | undefined)[];
  internalBias: number;
  swingBias: number;
  warnings: string[];
}
interface Pivot {
  level: number;
  last: number;
  crossed: boolean;
  index: number;
}
interface Structure {
  high: Pivot;
  low: Pivot;
  leg: number;
  bias: number;
}
interface Block {
  high: number;
  low: number;
  index: number;
  bias: number;
}
interface Gap {
  top: number;
  bottom: number;
  bias: number;
  drawings: SmcDrawing[];
}
const pivot = (): Pivot => ({
  level: NaN,
  last: NaN,
  crossed: false,
  index: 0,
});
const structure = (): Structure => ({
  high: pivot(),
  low: pivot(),
  leg: 0,
  bias: 0,
});
const seconds: Record<string, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '60m': 3600,
  '1d': 86400,
  '1w': 604800,
  '1M': 2592000,
};

// Vibe Quant uses UTC epoch bar STARTS. Calendar buckets follow Asia/Shanghai;
// logical drawing indices stay aligned with the chart's end-labelled candles.
const SHANGHAI_OFFSET = 8 * 3600;
export function smcBucket(time: number, timeframe: string): number {
  const d = new Date((time + SHANGHAI_OFFSET) * 1000);
  const day =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 -
    SHANGHAI_OFFSET;
  if (timeframe === '1M')
    return (
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - SHANGHAI_OFFSET
    );
  if (timeframe === '1w') return day - ((d.getUTCDay() + 6) % 7) * 86400;
  if (timeframe === '1d') return day;
  return Math.floor(time / seconds[timeframe]) * seconds[timeframe];
}
const bucket = smcBucket;
interface Group {
  key: number;
  bar: Candle;
  start: number;
  highIndex: number;
  lowIndex: number;
}
function grouped(bars: readonly Candle[], timeframe: string) {
  const groups: Group[] = [];
  const indices: number[] = [];
  bars.forEach((bar, index) => {
    const key = bucket(bar.time, timeframe);
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = {
        key,
        bar: { ...bar },
        start: index,
        highIndex: index,
        lowIndex: index,
      };
      groups.push(group);
    } else {
      if (bar.high > group.bar.high) group.highIndex = index;
      if (bar.low < group.bar.low) group.lowIndex = index;
      group.bar.high = Math.max(group.bar.high, bar.high);
      group.bar.low = Math.min(group.bar.low, bar.low);
      group.bar.close = bar.close;
      group.bar.isFinal = bar.isFinal;
    }
    indices.push(groups.length - 1);
  });
  return { groups, indices };
}

/** Pure replay: replacing an unclosed bar rolls back all its prior objects/events.
 * Input must be chronological and unique, using the SAME history window for parity.
 * No strategy filters, session resets or synthetic confirmation delays are added.
 */
export function calculateSmc(
  bars: readonly Candle[],
  input: Partial<SmcSettings> = {},
  interval = '1m',
  context: { dailyBars?: readonly Candle[] } = {},
): SmcResult {
  const s = normalizeSmcSettings(input);
  const result: SmcResult = {
    drawings: [],
    events: [],
    candleColors: [],
    internalBias: 0,
    swingBias: 0,
    warnings: [],
  };
  if (!bars.length) return result;
  const swing = structure(),
    internal = structure(),
    equal = structure();
  const internalBlocks: Block[] = [],
    swingBlocks: Block[] = [],
    gaps: Gap[] = [];
  const parsedHighs: number[] = [],
    parsedLows: number[] = [];
  const historical: SmcDrawing[] = [];
  const persistent = new Map<string, SmcDrawing>();
  const mono = s.styleInput === 'Monochrome';
  const bull = mono ? '#b2b5be' : s.swingBullColorInput;
  const bear = mono ? '#5d606b' : s.swingBearColorInput;
  const last = bars.length - 1;
  let atr = NaN,
    seed = 0,
    cumulativeTR = 0,
    cumulativeDelta = 0;
  let top = NaN,
    bottom = NaN,
    topIndex = 0,
    bottomIndex = 0,
    trailingIndex = 0;
  let serial = 0;
  const requestedFvg = s.fairValueGapsTimeframeInput || interval;
  const fvgSupported = seconds[requestedFvg] >= seconds[interval];
  // Daily history supplies full preceding weeks/months beyond the visible minute window.
  const daily = new Map<number, Candle>();
  for (const b of context.dailyBars ?? [])
    if (bucket(b.time, '1d') <= bucket(bars[last].time, '1d'))
      daily.set(bucket(b.time, '1d'), { ...b });
  for (const g of grouped(bars, '1d').groups) {
    const existing = daily.get(g.key);
    daily.set(
      g.key,
      existing
        ? {
            ...existing,
            high: Math.max(existing.high, g.bar.high),
            low: Math.min(existing.low, g.bar.low),
            close: g.bar.close,
          }
        : g.bar,
    );
  }
  const dailyBars = [...daily.values()].sort((a, b) => a.time - b.time);
  let fvg =
    s.showFairValueGapsInput && fvgSupported
      ? grouped(bars, requestedFvg)
      : null;
  if (s.showFairValueGapsInput && !fvgSupported)
    result.warnings.push(
      'FVG 所选周期小于图表周期，缺少更细 K 线，暂不绘制；请选择当前或更高周期。',
    );
  if (bars.length < 200)
    result.warnings.push(
      `ATR(200) 预热中：${bars.length}/200 根，EQH/EQL 阈值尚不可用。`,
    );
  if (
    s.showDailyLevelsInput ||
    s.showWeeklyLevelsInput ||
    s.showMonthlyLevelsInput ||
    (fvg && requestedFvg !== interval)
  )
    result.warnings.push(
      '多周期仅使用已加载 K 线；缺少完整周期时不绘制，可向左加载更多历史。FVG 沿用 Pine lookahead_on，历史与盘中可能重绘。',
    );
  const add = (key: string, drawing: SmcDrawing) => {
    if (s.modeInput === 'Present') persistent.set(key, drawing);
    else {
      historical.push(drawing);
      // Pine has separate 500-line and 500-label garbage collectors. A line with
      // a label is one logical drawing here; swing labels only consume labels.
      for (const kind of ['line', 'label'] as const) {
        const candidates = historical.filter((d) =>
          kind === 'line' ? d.kind === 'line' : Boolean(d.text),
        );
        if (candidates.length > 500) {
          const oldest = candidates[0];
          if (kind === 'label' && oldest.kind === 'line')
            oldest.text = undefined;
          else historical.splice(historical.indexOf(oldest), 1);
        }
      }
    }
  };
  const event = (i: number, type: string) =>
    result.events.push({
      time: bars[i].time,
      index: i,
      type,
      provisional: bars[i].isFinal === false,
    });
  const horizontal = (
    id: string,
    from: number,
    to: number,
    price: number,
    text: string,
    color: string,
    align: SmcDrawing['align'],
    labelIndex = to,
    size = 'tiny',
    style = 'solid',
  ): SmcDrawing => ({
    id,
    kind: 'line',
    from,
    to,
    top: price,
    bottom: price,
    color,
    text,
    align,
    labelIndex,
    size,
    style,
  });
  // Time coordinates in the Pine source use elapsed milliseconds, including
  // overnight/lunch gaps; map them onto the compressed trading-bar axis.
  const timeIndex = (time: number): number => {
    let lo = 0,
      hi = last;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (bars[mid].time < time) lo = mid + 1;
      else hi = mid - 1;
    }
    if (lo === 0) return (time - bars[0].time) / seconds[interval];
    if (lo > last) return last + (time - bars[last].time) / seconds[interval];
    return (
      lo - 1 + (time - bars[lo - 1].time) / (bars[lo].time - bars[lo - 1].time)
    );
  };
  if (fvg && seconds[requestedFvg] >= 86400 && dailyBars.length) {
    const higher = grouped(dailyBars, requestedFvg);
    const byKey = new Map(higher.groups.map((g, index) => [g.key, index]));
    higher.groups.forEach((g) => {
      // Place each calendar bucket on its first loaded chart bar.
      const first = bars.findIndex(
        (b) => bucket(b.time, requestedFvg) === g.key,
      );
      g.start = first >= 0 ? first : timeIndex(g.key);
    });
    fvg = {
      groups: higher.groups,
      indices: bars.map((b) => byKey.get(bucket(b.time, requestedFvg))!),
    };
  }
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i],
      previous = bars[i - 1];
    const tr = previous
      ? Math.max(
          b.high - b.low,
          Math.abs(b.high - previous.close),
          Math.abs(b.low - previous.close),
        )
      : b.high - b.low;
    seed += i < 200 ? tr : 0;
    if (i === 199) atr = seed / 200;
    else if (i >= 200) atr = (atr * 199 + tr) / 200;
    // ta.tr (variable) is na on the first bar; ta.atr uses ta.tr(true).
    if (previous) cumulativeTR += tr;
    const volatility =
      s.orderBlockFilterInput === 'Atr' ? atr : i ? cumulativeTR / i : NaN;
    const volatile = b.high - b.low >= 2 * volatility;
    parsedHighs.push(volatile ? b.low : b.high);
    parsedLows.push(volatile ? b.high : b.low);
    result.candleColors.push(
      s.showTrendInput ? (internal.bias === 1 ? bull : bear) : undefined,
    );
    const old = {
      swingHigh: swing.high.level,
      swingLow: swing.low.level,
      internalHigh: internal.high.level,
      internalLow: internal.low.level,
    };
    if (s.showHighLowSwingsInput || s.showPremiumDiscountZonesInput) {
      top = Math.max(b.high, top);
      bottom = Math.min(b.low, bottom);
      if (top === b.high) topIndex = i;
      if (bottom === b.low) bottomIndex = i;
      // These calls precede pivot/trend updates in Pine, including on the last bar.
      if (i === last) {
        const right = timeIndex(
          b.time + 20 * (b.time - (previous?.time ?? b.time)),
        );
        if (s.showHighLowSwingsInput) {
          persistent.set(
            'strongHigh',
            horizontal(
              'strongHigh',
              topIndex,
              right,
              top,
              swing.bias === -1 ? 'Strong High' : 'Weak High',
              bear,
              'above',
            ),
          );
          persistent.set(
            'strongLow',
            horizontal(
              'strongLow',
              bottomIndex,
              right,
              bottom,
              swing.bias === 1 ? 'Strong Low' : 'Weak Low',
              bull,
              'below',
            ),
          );
        }
        if (s.showPremiumDiscountZonesInput) {
          const premium = mono ? '#5d606b' : s.premiumZoneColorInput;
          const discount = mono ? '#b2b5be' : s.discountZoneColorInput;
          const zone = (
            id: string,
            high: number,
            low: number,
            price: number,
            color: string,
            labelIndex: number,
            align: SmcDrawing['align'],
          ) =>
            persistent.set(id, {
              id,
              kind: 'box',
              from: trailingIndex,
              to: last,
              top: high,
              bottom: low,
              color: color.slice(0, 7) + '33',
              text: id,
              labelPrice: price,
              labelIndex,
              align,
              size: 'small',
            });
          zone(
            'Premium',
            top,
            0.95 * top + 0.05 * bottom,
            top,
            premium,
            Math.round((trailingIndex + last) / 2),
            'above',
          );
          zone(
            'Equilibrium',
            0.525 * top + 0.475 * bottom,
            0.525 * bottom + 0.475 * top,
            (top + bottom) / 2,
            s.equilibriumZoneColorInput,
            last,
            'left',
          );
          zone(
            'Discount',
            0.95 * bottom + 0.05 * top,
            bottom,
            bottom,
            discount,
            Math.round((trailingIndex + last) / 2),
            'below',
          );
        }
      }
    }
    // Preserve forward array.remove iteration, including the shifted-next-item skip.
    if (fvg)
      for (let k = 0; k < gaps.length; k++) {
        const g = gaps[k];
        if (
          (g.bias === 1 && b.low < g.bottom) ||
          (g.bias === -1 && b.high > g.top)
        )
          gaps.splice(k, 1);
      }
    const getStructure = (
      state: Structure,
      length: number,
      kind: 'swing' | 'internal' | 'equal',
    ) => {
      if (i < length) return;
      const index = i - length;
      let highest = -Infinity,
        lowest = Infinity;
      for (let j = index + 1; j <= i; j++) {
        highest = Math.max(highest, bars[j].high);
        lowest = Math.min(lowest, bars[j].low);
      }
      const leg =
        bars[index].high > highest
          ? 0
          : bars[index].low < lowest
            ? 1
            : state.leg;
      if (leg === state.leg) return;
      state.leg = leg;
      const isLow = leg === 1,
        p = isLow ? state.low : state.high;
      const level = isLow ? bars[index].low : bars[index].high;
      if (
        kind === 'equal' &&
        Math.abs(p.level - level) < s.equalHighsLowsThresholdInput * atr
      ) {
        const tag = isLow ? 'EQL' : 'EQH';
        add(tag, {
          ...horizontal(
            `${tag}-${serial++}`,
            p.index,
            index,
            p.level,
            tag,
            isLow ? bull : bear,
            isLow ? 'below' : 'above',
            Math.round((p.index + index) / 2),
            s.equalHighsLowsSizeInput,
            'dotted',
          ),
          bottom: level,
          labelPrice: level,
        });
        event(i, isLow ? 'equalLows' : 'equalHighs');
      }
      p.last = p.level;
      p.level = level;
      p.crossed = false;
      p.index = index;
      if (kind === 'swing') {
        if (isLow) {
          bottom = level;
          bottomIndex = index;
        } else {
          top = level;
          topIndex = index;
        }
        trailingIndex = index;
        if (s.showSwingsInput)
          add(`pivot-${isLow}`, {
            id: `pivot-${serial++}`,
            kind: 'label',
            from: index,
            to: index,
            top: level,
            bottom: level,
            color: isLow ? bull : bear,
            text: isLow
              ? level < p.last
                ? 'LL'
                : 'HL'
              : level > p.last
                ? 'HH'
                : 'LH',
            align: isLow ? 'below' : 'above',
            size: 'small',
          });
      }
    };
    getStructure(swing, s.swingsLengthInput, 'swing');
    getStructure(internal, 5, 'internal');
    if (s.showEqualHighsLowsInput)
      getStructure(equal, s.equalHighsLowsLengthInput, 'equal');
    const display = (isInternal: boolean) => {
      const state = isInternal ? internal : swing;
      const name = isInternal ? 'internal' : 'swing';
      const blocks = isInternal ? internalBlocks : swingBlocks;
      for (const bias of [1, -1]) {
        const isBull = bias === 1,
          p = isBull ? state.high : state.low;
        const prevLevel = isInternal
          ? isBull
            ? old.internalHigh
            : old.internalLow
          : isBull
            ? old.swingHigh
            : old.swingLow;
        // Keep the source's unusual math.min(close, open - low) expression verbatim.
        const confluence =
          !s.internalFilterConfluenceInput ||
          (isBull
            ? b.high - Math.max(b.close, b.open) >
              Math.min(b.close, b.open - b.low)
            : b.high - Math.max(b.close, b.open) <
              Math.min(b.close, b.open - b.low));
        const swingLevel = isBull ? swing.high.level : swing.low.level;
        const extra =
          !isInternal ||
          (Number.isFinite(swingLevel) && p.level !== swingLevel && confluence);
        const crossed =
          previous &&
          (isBull
            ? b.close > p.level && previous.close <= prevLevel
            : b.close < p.level && previous.close >= prevLevel);
        if (!crossed || p.crossed || !extra) continue;
        const tag = state.bias === -bias ? 'CHoCH' : 'BOS';
        event(i, `${name}${isBull ? 'Bullish' : 'Bearish'}${tag}`);
        p.crossed = true;
        state.bias = bias;
        const show = isInternal ? s.showInternalsInput : s.showStructureInput;
        const filter = isInternal
          ? isBull
            ? s.showInternalBullInput
            : s.showInternalBearInput
          : isBull
            ? s.showSwingBullInput
            : s.showSwingBearInput;
        const color = mono
          ? isBull
            ? '#b2b5be'
            : '#5d606b'
          : isInternal
            ? isBull
              ? s.internalBullColorInput
              : s.internalBearColorInput
            : isBull
              ? bull
              : bear;
        if (show && (filter === 'All' || filter === tag))
          add(
            `${name}-${bias}`,
            horizontal(
              `${name}-${serial++}`,
              p.index,
              i,
              p.level,
              tag,
              color,
              isBull ? 'above' : 'below',
              Math.round((p.index + i) / 2),
              isInternal ? s.internalStructureSize : s.swingStructureSize,
              isInternal ? 'dashed' : 'solid',
            ),
          );
        if (
          isInternal
            ? s.showInternalOrderBlocksInput
            : s.showSwingOrderBlocksInput
        ) {
          let selected = p.index;
          for (let j = p.index + 1; j < i; j++)
            if (
              isBull
                ? parsedLows[j] < parsedLows[selected]
                : parsedHighs[j] > parsedHighs[selected]
            )
              selected = j;
          if (blocks.length >= 100) blocks.pop();
          blocks.unshift({
            high: parsedHighs[selected],
            low: parsedLows[selected],
            index: selected,
            bias,
          });
        }
      }
    };
    if (
      s.showInternalsInput ||
      s.showInternalOrderBlocksInput ||
      s.showTrendInput
    )
      display(true);
    if (
      s.showStructureInput ||
      s.showSwingOrderBlocksInput ||
      s.showHighLowSwingsInput
    )
      display(false);
    for (const [blocks, isInternal] of [
      [internalBlocks, true],
      [swingBlocks, false],
    ] as const) {
      if (
        !(isInternal
          ? s.showInternalOrderBlocksInput
          : s.showSwingOrderBlocksInput)
      )
        continue;
      for (let k = 0; k < blocks.length; k++) {
        const ob = blocks[k];
        const crossed =
          ob.bias === -1
            ? (s.orderBlockMitigationInput === 'Close' ? b.close : b.high) >
              ob.high
            : (s.orderBlockMitigationInput === 'Close' ? b.close : b.low) <
              ob.low;
        if (crossed) {
          blocks.splice(k, 1);
          event(
            i,
            `${isInternal ? 'internal' : 'swing'}${ob.bias === 1 ? 'Bullish' : 'Bearish'}OrderBlock`,
          );
        }
      }
      // Pine reuses preallocated boxes without clearing spare slots. Reproduce the
      // two final drawing passes so a mitigated final-bar slot can remain visible.
      if (i === last || (i === last - 1 && bars[last].isFinal === false))
        blocks
          .slice(
            0,
            isInternal
              ? s.internalOrderBlocksSizeInput
              : s.swingOrderBlocksSizeInput,
          )
          .forEach((ob, k) => {
            const color = mono
              ? ob.bias === 1
                ? '#b2b5be33'
                : '#5d606b33'
              : isInternal
                ? ob.bias === 1
                  ? s.internalBullishOrderBlockColor
                  : s.internalBearishOrderBlockColor
                : ob.bias === 1
                  ? s.swingBullishOrderBlockColor
                  : s.swingBearishOrderBlockColor;
            const id = `${isInternal ? 'internal' : 'swing'}-ob-${k}`;
            persistent.set(id, {
              id,
              kind: 'box',
              from: ob.index,
              to: last,
              top: ob.high,
              bottom: ob.low,
              color,
              border: !isInternal,
              extendRight: true,
            });
          });
    }
    if (fvg) {
      const gi = fvg.indices[i],
        g = fvg.groups[gi],
        prev = fvg.groups[gi - 1],
        prev2 = fvg.groups[gi - 2];
      const newTimeframe = i === 0 || fvg.indices[i - 1] !== gi;
      const delta = prev
        ? (prev.bar.close - prev.bar.open) / (prev.bar.open * 100)
        : NaN;
      if (newTimeframe && Number.isFinite(delta))
        cumulativeDelta += Math.abs(delta);
      const threshold = s.fairValueGapsThresholdInput
        ? (cumulativeDelta / i) * 2
        : 0;
      // Same timeframe needs no grouping warmup; otherwise exclude the partial first bucket.
      if (
        prev &&
        prev2 &&
        (requestedFvg === interval || gi >= 3) &&
        newTimeframe
      ) {
        const bullish =
          g.bar.low > prev2.bar.high &&
          prev.bar.close > prev2.bar.high &&
          delta > threshold;
        const bearish =
          g.bar.high < prev2.bar.low &&
          prev.bar.close < prev2.bar.low &&
          -delta > threshold;
        if (bullish || bearish) {
          const gapTop = bullish ? g.bar.low : g.bar.high,
            gapBottom = bullish ? prev2.bar.high : prev2.bar.low;
          const middle = (gapTop + gapBottom) / 2;
          const color = mono
            ? bullish
              ? '#b2b5be4d'
              : '#5d606b4d'
            : bullish
              ? s.fairValueGapsBullColorInput
              : s.fairValueGapsBearColorInput;
          const to = timeIndex(
            (bars[g.start]?.time ?? g.key) +
              s.fairValueGapsExtendInput *
                (b.time - (previous?.time ?? b.time)),
          );
          const drawings: SmcDrawing[] = [
            [gapTop, middle],
            [middle, gapBottom],
          ].map(([high, low]) => ({
            id: `fvg-${serial++}`,
            kind: 'box',
            from: prev.start,
            to,
            top: high,
            bottom: low,
            color,
            border: true,
          }));
          gaps.unshift({
            top: gapTop,
            bottom: gapBottom,
            bias: bullish ? 1 : -1,
            drawings,
          });
          if (gaps.length > 250) gaps.pop();
          event(i, bullish ? 'bullishFairValueGap' : 'bearishFairValueGap');
        }
      }
    }
  }
  for (const [tf, show, style, color, tag] of [
    [
      '1d',
      s.showDailyLevelsInput,
      s.dailyLevelsStyleInput,
      s.dailyLevelsColorInput,
      'D',
    ],
    [
      '1w',
      s.showWeeklyLevelsInput,
      s.weeklyLevelsStyleInput,
      s.weeklyLevelsColorInput,
      'W',
    ],
    [
      '1M',
      s.showMonthlyLevelsInput,
      s.monthlyLevelsStyleInput,
      s.monthlyLevelsColorInput,
      'M',
    ],
  ] as const) {
    if (!show) continue;
    if (seconds[tf] < seconds[interval]) {
      result.warnings.push(
        `${tag} 高低点周期小于图表周期，缺少更细 K 线，暂不绘制。`,
      );
      continue;
    }
    const { groups } = grouped(dailyBars, tf);
    const same = interval === tf;
    const g = same
      ? {
          bar: bars[last],
          highIndex: last,
          lowIndex: last,
          key: bucket(bars[last].time, tf),
        }
      : groups.length >= (tf === '1d' && context.dailyBars?.length ? 2 : 3)
        ? groups.at(-2)
        : undefined;
    if (!g) {
      result.warnings.push(`${tag} 高低点缺少完整上一周期数据，暂不绘制。`);
      continue;
    }
    let highIndex = same ? last : 0,
      lowIndex = same ? last : 0;
    if (!same) {
      let high = -Infinity,
        low = Infinity;
      bars.forEach((b, index) => {
        if (bucket(b.time, tf) !== g.key) return;
        if (b.high > high) {
          high = b.high;
          highIndex = index;
        }
        if (b.low < low) {
          low = b.low;
          lowIndex = index;
        }
      });
    }
    const to = timeIndex(
      bars[last].time +
        20 * (bars[last].time - (bars[last - 1]?.time ?? bars[last].time)),
    );
    persistent.set(
      `${tag}H`,
      horizontal(
        `${tag}H`,
        highIndex,
        to,
        g.bar.high,
        `P${tag}H`,
        color,
        'left',
        to,
        'small',
        style,
      ),
    );
    persistent.set(
      `${tag}L`,
      horizontal(
        `${tag}L`,
        lowIndex,
        to,
        g.bar.low,
        `P${tag}L`,
        color,
        'left',
        to,
        'small',
        style,
      ),
    );
  }
  result.drawings = [
    ...historical,
    ...persistent.values(),
    ...gaps.flatMap((g) => g.drawings),
  ].filter((d) => Number.isFinite(d.top) && Number.isFinite(d.bottom));
  result.internalBias = internal.bias;
  result.swingBias = swing.bias;
  return result;
}
