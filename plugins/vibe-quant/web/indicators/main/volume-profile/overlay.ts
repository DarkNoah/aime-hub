import type { Bar } from '../../../../shared';
import {
  PROFILE_DAY,
  PROFILE_RANGES,
  profileRangeStart,
  type ProfileRange,
  type VolumeProfileData,
} from '../../../../volume-profile';
import type { IndicatorOverlay, IndicatorParameters } from '../../types';

/** Match stock-rl's geometry, directional colors and neutral value-area color. */
export function volumeProfileOverlay(
  bars: readonly Bar[],
  parameters: IndicatorParameters,
  duration: number,
  data?: VolumeProfileData,
): IndicatorOverlay {
  const result: IndicatorOverlay = { drawings: [], warnings: [] };
  const span = PROFILE_RANGES[parameters.range as ProfileRange] ?? PROFILE_DAY;
  if (duration >= PROFILE_DAY && span < PROFILE_DAY)
    return {
      drawings: [],
      warnings: ['成交量分布：分钟、小时范围请切换至分钟 K 线查看。'],
    };
  if (duration > PROFILE_DAY)
    return {
      drawings: [],
      warnings: ['成交量分布：请切换至日线或分钟 K 线查看。'],
    };
  if (!data) return result;
  result.warnings = data.warnings;
  const groups = new Map<number, { left: number; right: number }>();
  bars.forEach((bar, index) => {
    const last =
      duration < PROFILE_DAY ? bar.time + duration - 0.001 : bar.time;
    for (
      let start = profileRangeStart(bar.time, span);
      start <= last;
      start += span
    ) {
      const left =
        index -
        0.45 +
        (span < PROFILE_DAY
          ? (Math.max(0, start - bar.time) / duration) * 0.9
          : 0);
      const right =
        index +
        0.45 -
        (span < PROFILE_DAY
          ? (Math.max(0, bar.time + duration - start - span) / duration) * 0.9
          : 0);
      const group = groups.get(start);
      if (group) group.right = right;
      else groups.set(start, { left, right });
    }
  });
  for (const { start, profile } of data.segments) {
    const group = groups.get(start);
    if (!group) continue;
    const { left, right } = group;
    const id = `vp:${start}`,
      width = (right - left) * 0.42;
    const max = Math.max(...profile.rows.map((row) => row.total));
    for (const [index, row] of profile.rows.entries()) {
      let offset = left;
      for (const [side, color] of [
        ['buy', '#e74c3cb3'],
        ['unknown', '#95a5a6b3'],
        ['sell', '#27ae60b3'],
      ] as const) {
        const size = (width * row[side]) / max;
        if (size <= 0) continue;
        const padding = (row.high - row.low) * 0.07;
        result.drawings.push({
          id: `${id}:${index}:${side}`,
          kind: 'box',
          from: offset,
          to: offset + size,
          top: row.high - padding,
          bottom: row.low + padding,
          color: row.inValueArea ? color : '#b6bdc680',
        });
        offset += size;
      }
    }
    for (const [name, price, color] of [
      ['POC', profile.poc, '#8e44ad'],
      ['VAH', profile.vah, '#b97500'],
      ['VAL', profile.val, '#b97500'],
      ['VWAP', profile.vwap, '#2980b9'],
    ] as const) {
      result.drawings.push({
        id: `${id}:${name}`,
        kind: 'line',
        from: left,
        to: right,
        top: price,
        bottom: price,
        color,
        style: name === 'VWAP' ? 'dotted' : 'dashed',
        lineWidth: name === 'POC' ? 1.5 : 1,
        text: name,
        labelIndex: right,
        align: 'left',
        size: 'tiny',
      });
    }
  }
  return result;
}
