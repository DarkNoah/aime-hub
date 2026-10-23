import { MONTH_DURATION, type Bar } from '../../shared';

export type LineDrawingKind = 'trend' | 'ray' | 'segment';
export type TwoPointDrawingKind = LineDrawingKind | 'fibonacci';
export type DrawingTool =
  'cursor' | TwoPointDrawingKind | 'horizontal' | 'long' | 'short';
export interface Anchor {
  time: number;
  price: number;
}
export type Drawing = (
  | { id: string; kind: LineDrawingKind; start: Anchor; end: Anchor }
  | FibonacciDrawing
  | { id: string; kind: 'horizontal'; price: number }
  | PositionDrawing
) & { crossPeriod?: boolean };
export interface FibonacciOptions {
  reverse: boolean;
  extendLeft: boolean;
  extendRight: boolean;
  background: boolean;
}
export interface FibonacciDrawing extends Partial<FibonacciOptions> {
  id: string;
  kind: 'fibonacci';
  start: Anchor;
  end: Anchor;
}
export function fibonacciOptions(
  drawing: Partial<FibonacciOptions>,
): FibonacciOptions {
  return {
    reverse: drawing.reverse ?? false,
    extendLeft: drawing.extendLeft ?? false,
    extendRight: drawing.extendRight ?? false,
    background: drawing.background ?? true,
  };
}
export interface PositionDrawing {
  id: string;
  kind: 'position';
  side: 'long' | 'short';
  start: number;
  end: number;
  entry: number;
  target: number;
  stop: number;
  crossPeriod?: boolean;
}
export interface Point {
  x: number;
  y: number;
}
export type DrawingPart =
  'start' | 'end' | 'line' | 'entry' | 'target' | 'stop';
export interface DrawingState {
  tool: DrawingTool;
  selected: string | null;
  count: number;
  placingEnd: boolean;
  crossPeriod: boolean;
  sharedCount: number;
  selectedPosition: PositionDrawing['side'] | null;
  selectedFibonacci: FibonacciOptions | null;
}
export const EMPTY_DRAWING_STATE: DrawingState = {
  tool: 'cursor',
  selected: null,
  count: 0,
  placingEnd: false,
  crossPeriod: false,
  sharedCount: 0,
  selectedPosition: null,
  selectedFibonacci: null,
};

export const drawingStorageKey = (scope: string) =>
  `vibe-quant:drawings:v1:${encodeURIComponent(scope)}`;
export const sharedDrawingStorageKey = (scope: string) =>
  `vibe-quant:drawings:shared:v1:${encodeURIComponent(scope)}`;

export function isTwoPointTool(value: unknown): value is TwoPointDrawingKind {
  return (
    value === 'trend' ||
    value === 'ray' ||
    value === 'segment' ||
    value === 'fibonacci'
  );
}

function anchor(value: unknown): value is Anchor {
  if (!value || typeof value !== 'object') return false;
  const point = value as Anchor;
  return (
    Number.isSafeInteger(point.time) &&
    point.time > 0 &&
    typeof point.price === 'number' &&
    Number.isFinite(point.price)
  );
}

function validPosition(value: PositionDrawing): boolean {
  const direction = value.side === 'long' ? 1 : -1;
  return (
    (value.side === 'long' || value.side === 'short') &&
    [value.start, value.end].every(
      (time) => Number.isSafeInteger(time) && time > 0,
    ) &&
    value.start !== value.end &&
    [value.entry, value.target, value.stop].every(
      (price) => typeof price === 'number' && Number.isFinite(price),
    ) &&
    direction * (value.target - value.entry) > 0 &&
    direction * (value.entry - value.stop) > 0
  );
}

/** Either exit can be placed first; infer its role from side and price direction. */
export function createPosition(
  id: string,
  side: PositionDrawing['side'],
  entry: Anchor,
  exit: Anchor,
): PositionDrawing | null {
  const profit = (side === 'long' ? 1 : -1) * (exit.price - entry.price) > 0;
  const target = profit
    ? exit.price
    : entry.price + (entry.price - exit.price) * 2;
  const stop = profit
    ? entry.price - (exit.price - entry.price) / 2
    : exit.price;
  const position: PositionDrawing = {
    id,
    kind: 'position',
    side,
    start: entry.time,
    end: exit.time,
    entry: entry.price,
    target,
    stop,
  };
  return validPosition(position) ? position : null;
}

export function adjustPosition(
  position: PositionDrawing,
  part: 'entry' | 'target' | 'stop',
  price: number,
  tick: number,
): PositionDrawing {
  const direction = position.side === 'long' ? 1 : -1;
  const gap = Math.min(
    Math.max(tick, 1e-8),
    Math.abs(position.target - position.stop) / 4,
  );
  const value =
    part === 'entry'
      ? Math.max(
          Math.min(position.stop, position.target) + gap,
          Math.min(Math.max(position.stop, position.target) - gap, price),
        )
      : part === 'target'
        ? position.entry +
          direction * Math.max(gap, direction * (price - position.entry))
        : position.entry -
          direction * Math.max(gap, direction * (position.entry - price));
  return { ...position, [part]: value };
}

export function positionRatio(position: PositionDrawing): number {
  return (
    Math.abs(position.target - position.entry) /
    Math.abs(position.entry - position.stop)
  );
}

export function parseDrawings(raw: string | null): Drawing[] {
  try {
    const data: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(data)) return [];
    const ids = new Set<string>();
    return data.flatMap((item): Drawing[] => {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.id !== 'string' ||
        !item.id ||
        ids.has(item.id)
      )
        return [];
      let drawing: Drawing;
      if (
        item.kind === 'horizontal' &&
        typeof item.price === 'number' &&
        Number.isFinite(item.price)
      )
        drawing = { id: item.id, kind: item.kind, price: item.price };
      else if (
        isTwoPointTool(item.kind) &&
        anchor(item.start) &&
        anchor(item.end)
      )
        drawing = {
          id: item.id,
          kind: item.kind,
          start: { ...item.start },
          end: { ...item.end },
        };
      else if (item.kind === 'position' && validPosition(item))
        drawing = {
          id: item.id,
          kind: 'position',
          side: item.side,
          start: item.start,
          end: item.end,
          entry: item.entry,
          target: item.target,
          stop: item.stop,
        };
      else return [];
      if (drawing.kind === 'fibonacci') {
        for (const key of [
          'reverse',
          'extendLeft',
          'extendRight',
          'background',
        ] as const)
          if (typeof item[key] === 'boolean') drawing[key] = item[key];
      }
      if (item.crossPeriod === true) drawing.crossPeriod = true;
      ids.add(item.id);
      return [drawing];
    });
  } catch {
    return [];
  }
}

/** Actual candle times remain stable when older bars are prepended. */
export function barEndTime(bar: Bar): number {
  if (bar.duration !== MONTH_DURATION) return bar.time + bar.duration;
  const date = new Date((bar.time + 8 * 3600) * 1000);
  return (
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000 - 8 * 3600
  );
}

export function logicalAtTime(time: number, bars: Bar[]): number | null {
  if (!bars.length) return null;
  let low = 0,
    high = bars.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (bars[mid].time < time) low = mid + 1;
    else high = mid;
  }
  if (bars[low]?.time === time) return low;
  if (low === 0) return (time - bars[0].time) / bars[0].duration;
  if (low === bars.length)
    return (
      low -
      1 +
      (time - bars[low - 1].time) /
        (barEndTime(bars[low - 1]) - bars[low - 1].time)
    );
  return (
    low -
    1 +
    (time - bars[low - 1].time) / (bars[low].time - bars[low - 1].time)
  );
}

export function segmentDistance(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const length = dx * dx + dy * dy;
  const ratio = length
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * dx + (point.y - start.y) * dy) / length,
        ),
      )
    : 0;
  return Math.hypot(
    point.x - start.x - ratio * dx,
    point.y - start.y - ratio * dy,
  );
}

/** Clip the forward ray to the pane, including rays whose anchors are offscreen. */
export function raySegment(
  start: Point,
  end: Point,
  width: number,
  height: number,
): [Point, Point] | null {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  if (dx === 0 && dy === 0)
    return start.x >= 0 && start.x <= width && start.y >= 0 && start.y <= height
      ? [start, end]
      : null;
  let from = 0,
    to = Infinity;
  for (const [origin, direction, limit] of [
    [start.x, dx, width],
    [start.y, dy, height],
  ]) {
    if (direction === 0) {
      if (origin < 0 || origin > limit) return null;
      continue;
    }
    const first = -origin / direction,
      last = (limit - origin) / direction;
    from = Math.max(from, Math.min(first, last));
    to = Math.min(to, Math.max(first, last));
    if (from > to) return null;
  }
  return [
    { x: start.x + from * dx, y: start.y + from * dy },
    { x: start.x + to * dx, y: start.y + to * dy },
  ];
}

export function moveDrawing(
  drawing: Drawing,
  deltaBars: number,
  deltaPrice: number,
  bars: Bar[],
): Drawing {
  if (drawing.kind === 'horizontal')
    return { ...drawing, price: drawing.price + deltaPrice };
  const startTime =
    drawing.kind === 'position' ? drawing.start : drawing.start.time;
  const endTime = drawing.kind === 'position' ? drawing.end : drawing.end.time;
  const start = logicalAtTime(startTime, bars);
  const end = logicalAtTime(endTime, bars);
  if (start === null || end === null) return drawing;
  // Keep both anchors in the available data, preserving the line's span.
  const minimum = -Math.min(start, end),
    maximum = bars.length - 1 - Math.max(start, end);
  const requestedShift = Math.round(deltaBars);
  const shift =
    requestedShift !== 0 && minimum <= maximum
      ? requestedShift > 0
        ? Math.max(0, Math.min(maximum, requestedShift))
        : Math.min(0, Math.max(minimum, requestedShift))
      : 0;
  const moveTime = (time: number, index: number) => {
    if (!shift) return time;
    const next = index + shift,
      left = Math.floor(next),
      fraction = next - left;
    if (!bars[left]) return time;
    const endTime = bars[left + 1]?.time ?? barEndTime(bars[left]);
    return Math.round(bars[left].time + fraction * (endTime - bars[left].time));
  };
  if (drawing.kind === 'position')
    return {
      ...drawing,
      start: moveTime(drawing.start, start),
      end: moveTime(drawing.end, end),
      entry: drawing.entry + deltaPrice,
      target: drawing.target + deltaPrice,
      stop: drawing.stop + deltaPrice,
    };
  return {
    ...drawing,
    start: {
      time: moveTime(drawing.start.time, start),
      price: drawing.start.price + deltaPrice,
    },
    end: {
      time: moveTime(drawing.end.time, end),
      price: drawing.end.price + deltaPrice,
    },
  };
}
