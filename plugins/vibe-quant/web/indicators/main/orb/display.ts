// Adapted from ORB Algo | Flux Charts, © fluxchart, MPL-2.0.
// https://mozilla.org/MPL/2.0/
import type { Bar } from '../../../../shared';
import type { IndicatorDashboard, IndicatorDrawing } from '../../types';
import type { OrbResult, OrbSession } from './engine';
import type { OrbSettings } from './settings';

const difference = (value: number, reference: number) =>
  (Math.abs(value - reference) / reference) * 100;
const price = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value)
    ? '—'
    : String(Number(value.toFixed(6)));
const percent = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}%`;

/** Deliberately reproduces Pine's simplified, absolute-difference accounting. */
export function orbStatistics(sessions: readonly OrbSession[], ratios: string) {
  const weights = ratios
    .split(' | ')
    .map((value) => Number(value.replace('%', '')) / 100);
  let wins = 0,
    losses = 0,
    total = 0;
  for (const orb of sessions) {
    if (orb.entryPrice === undefined) continue;
    let taken = 0;
    for (const [index, target] of orb.targets.entries()) {
      total += difference(target.price, orb.entryPrice) * weights[index];
      taken += weights[index];
    }
    if (
      orb.slIndex !== undefined &&
      orb.slIndex !== -1 &&
      orb.slPrice !== undefined
    ) {
      total -= difference(orb.slPrice, orb.entryPrice) * (1 - taken);
      if (taken === 0) losses++;
    }
    if (orb.targets.length) wins++;
  }
  return {
    days: sessions.length,
    wins,
    losses,
    total,
    winRate: wins + losses ? (wins / (wins + losses)) * 100 : undefined,
    average: wins + losses ? total / (wins + losses) : undefined,
  };
}

export function orbDisplay(
  bars: readonly Bar[],
  settings: OrbSettings,
  result: Pick<OrbResult, 'sessions' | 'events'>,
) {
  const { sessions, events } = result;
  const last = bars.length - 1;
  const latest = sessions.at(-1);
  const drawings: IndicatorDrawing[] = [];
  const labels: IndicatorDrawing[] = [];
  const visibleSessions = settings.showHistoricZones
    ? sessions
    : latest
      ? [latest]
      : [];
  for (const orb of visibleSessions
    .filter((value) => value.startIndex > last - 5000)
    .slice(-250)) {
    if (settings.showORBZones) {
      for (const [key, value, color] of [
        ['high', orb.high, settings.highColor],
        ['low', orb.low, settings.lowColor],
      ] as const) {
        drawings.push({
          id: `orb:${orb.startTime}:${key}`,
          kind: 'line',
          from: orb.startIndex,
          to: orb.endIndex ?? last,
          top: value,
          bottom: value,
          color,
          lineWidth: 2,
        });
      }
    }
    if (orb.entryIndex !== undefined && orb.entryPrice !== undefined) {
      const entryBar = bars[orb.entryIndex];
      const value = orb.entryBullish ? entryBar.low : entryBar.high;
      labels.push({
        id: `orb:${orb.startTime}:entry`,
        kind: 'label',
        from: orb.entryIndex,
        to: orb.entryIndex,
        top: value,
        bottom: value,
        text: orb.entryBullish ? 'Buy' : 'Sell',
        color: '#ffffff',
        labelBackground: orb.entryBullish ? '#26843d' : '#c82d3b',
        labelPointer: true,
        align: orb.entryBullish ? 'below' : 'above',
        size: 'small',
      });
    }
  }
  for (const event of events) {
    if (
      event.type === 'Buy' ||
      event.type === 'Sell' ||
      event.index <= last - 5000 ||
      (!settings.showHistoricZones && event.session !== latest)
    )
      continue;
    const bar = bars[event.index];
    const above = event.type.startsWith('TP')
      ? event.session.entryBullish
      : !event.session.entryBullish;
    const value = above ? bar.high : bar.low;
    labels.push({
      id: `orb:${event.session.startTime}:${event.type}`,
      kind: 'label',
      from: event.index,
      to: event.index,
      top: value,
      bottom: value,
      text: event.type,
      color: '#ffffff',
      labelBackground: event.type.startsWith('TP') ? '#285fa8' : '#c82d3b',
      labelPointer: true,
      align: above ? 'above' : 'below',
      size: 'small',
    });
  }
  drawings.push(...labels.sort((a, b) => a.from - b.from).slice(-500));
  const dashboards: IndicatorDashboard[] = [];
  if (settings.orbDisplayEnabled) {
    const entry = latest?.entryPrice;
    const pnl =
      entry === undefined || !bars.length
        ? undefined
        : (((bars[last].close - entry) * (latest?.entryBullish ? 1 : -1)) /
            entry) *
          100;
    const rows: IndicatorDashboard['rows'] = [
      {
        label: '方向',
        value:
          entry === undefined
            ? 'No Signal'
            : latest?.entryBullish
              ? 'Bullish'
              : 'Bearish',
        status: true,
      },
      {
        label: latest?.entryBullish ? 'Buy Price' : 'Sell Price',
        value: price(entry),
      },
      { label: '入场后涨跌', value: percent(pnl) },
    ];
    if (entry !== undefined) {
      if (settings.tpMethod === 'ATR') {
        for (const [index, mult] of [0.75, 1.5, 2.25].entries())
          rows.push({
            label: `TP ${index + 1}`,
            value: price(
              latest?.entryATR === undefined
                ? undefined
                : entry +
                    latest.entryATR * mult * (latest.entryBullish ? 1 : -1),
            ),
          });
      }
      rows.push({ label: 'SL', value: price(latest?.slPrice) });
    }
    dashboards.push({
      id: 'orb-status',
      title: 'ORB Dashboard',
      position: settings.orbLocation,
      rows,
    });
  }
  if (settings.backtestDisplayEnabled) {
    const stats = orbStatistics(sessions, settings.backtestingExitRatios);
    dashboards.push({
      id: 'orb-backtest',
      title: 'ORB 原稿模拟',
      position: settings.backtestingLocation,
      rows: [
        { label: '时段', value: String(stats.days) },
        { label: '胜 / 负', value: `${stats.wins} / ${stats.losses}` },
        { label: '胜率', value: percent(stats.winRate) },
        { label: '平均收益', value: percent(stats.average) },
        { label: '累计收益', value: percent(stats.total) },
      ],
      note: '已加载历史 · 原稿简化统计 · 未计费用',
    });
  }
  return { drawings, dashboards };
}
