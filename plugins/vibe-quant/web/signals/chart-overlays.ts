import type { IndicatorDrawing } from '../indicators/types';
import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import type { Bar } from '../../shared';
import type { MarketStrategyHint } from '../../signal-types';
import { tradeCandleTime } from '../trade-markers';
import { barLabelTime } from '../chart-time';
import { pricePrecision } from '../readout-format';
import { exitMarkerLabel, exitReasonColor } from '../trade-exit';
import { tradeRiskDrawings, tradeRiskLevels } from '../trade-risk';

export function strategyHintMarkers(
  hints: readonly MarketStrategyHint[],
  bars: Bar[],
  duration: number,
  priceTick: number,
): SeriesMarker<UTCTimestamp>[] {
  const visibleHints = hints.filter(
    (hint) =>
      (hint.config.display_symbol ?? hint.config.symbol) === bars[0]?.symbol,
  );
  return visibleHints
    .flatMap((hint) =>
      hint.signals.flatMap((signal) => {
        const anchor = tradeCandleTime(
          signal.chart_time ?? signal.time,
          bars,
          duration,
        );
        if (anchor === null) return [];
        const name =
          hint.strategy_name.length > 6
            ? `${hint.strategy_name.slice(0, 6)}…`
            : hint.strategy_name;
        const buy = (signal.type === 'entry') === (signal.side !== 'short');
        const prefix =
          hint.config.symbol !== bars[0]?.symbol
            ? `${hint.config.symbol} ${name} `
            : visibleHints.length > 1
              ? `${name} v${hint.version_number} `
              : '';
        return [
          {
            id: signal.id,
            time: barLabelTime(anchor, duration) as UTCTimestamp,
            position: buy ? ('belowBar' as const) : ('aboveBar' as const),
            shape: buy ? ('arrowUp' as const) : ('arrowDown' as const),
            color:
              signal.type === 'entry'
                ? '#2563eb'
                : exitReasonColor(signal.reason),
            text: `${prefix}${signal.type === 'entry' ? '入场' : exitMarkerLabel(signal.reason)}${signal.price === null ? '' : ` ${signal.symbol !== hint.config.symbol ? '实际 ' : ''}${hint.config.symbol === bars[0]?.symbol ? signal.price.toFixed(pricePrecision(priceTick)) : signal.price.toString()}`}`,
          },
        ];
      }),
    )
    .sort((a, b) => a.time - b.time || (a.id ?? '').localeCompare(b.id ?? ''));
}
export function strategyHintLines(
  hints: readonly MarketStrategyHint[],
  symbol: string,
) {
  return hints
    .filter(
      (hint) =>
        hint.config.symbol === symbol &&
        hint.enabled &&
        hint.status === 'running',
    )
    .flatMap((hint) =>
      hint.overlay.levels.flatMap((level) =>
        (
          [
            ['chart_take_profit', '止盈', '#dc4c5c'],
            ['chart_stop_loss', '止损', '#16a085'],
          ] as const
        ).flatMap(([key, label, color]) =>
          level[key] === null
            ? []
            : [
                {
                  id: `${hint.id}:${level.id}:${key}`,
                  time: level.chart_time ?? level.time,
                  price: level[key],
                  color,
                  lineWidth: 1 as const,
                  lineStyle: 2 as const,
                  axisLabelVisible: true,
                  title: `${hint.strategy_name.slice(0, 12)} v${hint.version_number} ${label}`,
                },
              ],
        ),
      ),
    );
}

/** Use the existing primitive so active protection prices participate in visible-window autoscaling. */
export function strategyHintDrawings(
  hints: readonly MarketStrategyHint[],
  bars: Bar[],
  duration: number,
  priceTick: number,
): IndicatorDrawing[] {
  if (!bars.length) return [];
  const covered = new Set<string>();
  const ranges = hints
    .filter((hint) => hint.config.symbol === bars[0].symbol)
    .flatMap((hint) =>
      (hint.trades ?? []).flatMap((trade) => {
        // Actual-contract prices need their own historical basis projection;
        // never place them directly on an unadjusted main-price chart.
        if (trade.symbol !== bars[0].symbol || !trade.risk_levels?.length)
          return [];
        covered.add(`${hint.id}:${trade.entry_signal_id}`);
        return tradeRiskDrawings(
          trade,
          tradeRiskLevels(trade, trade.risk_levels),
          bars,
          duration,
          priceTick,
        ).map((drawing) => ({
          ...drawing,
          id: `${hint.id}:${trade.id}:${drawing.id}`,
        }));
      }),
    );
  const remaining = hints.map((hint) => ({
    ...hint,
    overlay: {
      ...hint.overlay,
      levels: hint.overlay.levels.filter(
        (level) => !covered.has(`${hint.id}:${level.entry_signal_id}`),
      ),
    },
  }));
  const groups = new Map<
    string,
    { line: ReturnType<typeof strategyHintLines>[number]; titles: Set<string> }
  >();
  for (const line of strategyHintLines(remaining, bars[0].symbol)) {
    if (line.time > bars.at(-1)!.time + duration) continue;
    const key = `${line.price}:${line.color}`;
    const group = groups.get(key);
    if (group) {
      group.line.time = Math.min(group.line.time, line.time);
      group.titles.add(line.title);
    } else
      groups.set(key, { line: { ...line }, titles: new Set([line.title]) });
  }
  return [
    ...ranges,
    ...[...groups.values()].map(({ line, titles }): IndicatorDrawing => ({
      id: line.id,
      kind: 'line',
      from: Math.max(
        0,
        bars.findLastIndex((bar) => bar.time <= line.time),
      ),
      to: bars.length,
      top: line.price,
      bottom: line.price,
      color: line.color,
      lineWidth: 2,
      style: 'dashed',
      text: `${[...titles].join(' / ')} ${line.price.toFixed(pricePrecision(priceTick))}`,
      labelIndex: bars.length,
      clampLabel: true,
      align: line.title.endsWith('止盈') ? 'above' : 'below',
      size: 'small',
    })),
  ];
}
