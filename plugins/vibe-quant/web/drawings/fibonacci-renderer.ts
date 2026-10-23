import { segmentDistance, type FibonacciDrawing, type Point } from './model';

const LEVELS = [
  { ratio: 0, color: '#787b86' },
  { ratio: 0.236, color: '#e05260' },
  { ratio: 0.382, color: '#d98a24' },
  { ratio: 0.5, color: '#35a16b' },
  { ratio: 0.618, color: '#219a95' },
  { ratio: 0.786, color: '#4582cf' },
  { ratio: 1, color: '#787b86' },
] as const;

/** 0 is the end of the measured move; 1 is a full retracement to its origin. */
export function fibonacciLevels(drawing: FibonacciDrawing) {
  const zero = drawing.reverse ? drawing.start.price : drawing.end.price;
  const one = drawing.reverse ? drawing.end.price : drawing.start.price;
  return LEVELS.map((level) => ({
    ...level,
    price: zero + (one - zero) * level.ratio,
  }));
}

export function fibonacciGeometry(
  drawing: FibonacciDrawing,
  anchors: [Point, Point],
  width: number,
  priceToCoordinate: (price: number) => number | null,
) {
  const [start, end] = anchors;
  const left = drawing.extendLeft ? 0 : Math.max(0, Math.min(start.x, end.x));
  const right = drawing.extendRight
    ? width
    : Math.min(width, Math.max(start.x, end.x));
  if (left > right) return null;
  const levels = fibonacciLevels(drawing).flatMap((level) => {
    // Project each actual price so zooming and non-linear scales stay accurate.
    const y = priceToCoordinate(level.price);
    return y === null || !Number.isFinite(y) ? [] : [{ ...level, y }];
  });
  return { start, end, left, right, levels };
}

type FibonacciGeometry = NonNullable<ReturnType<typeof fibonacciGeometry>>;

export function hitFibonacci(
  point: Point,
  geometry: FibonacciGeometry,
): boolean {
  return (
    segmentDistance(point, geometry.start, geometry.end) <= 7 ||
    geometry.levels.some(
      ({ y }) =>
        segmentDistance(
          point,
          { x: geometry.left, y },
          { x: geometry.right, y },
        ) <= 7,
    )
  );
}

export function drawFibonacci(
  ctx: CanvasRenderingContext2D,
  geometry: FibonacciGeometry,
  drawing: FibonacciDrawing,
  selected: boolean,
  preview: boolean,
  size: { width: number; height: number },
  format: (price: number) => string,
  dark: boolean,
) {
  const { start, end, left, right, levels } = geometry;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, size.width, size.height);
  ctx.clip();
  if (drawing.background !== false) {
    ctx.globalAlpha = selected ? 0.12 : 0.08;
    for (let i = 1; i < levels.length; i++) {
      const top = Math.max(0, Math.min(levels[i - 1].y, levels[i].y));
      const bottom = Math.min(
        size.height,
        Math.max(levels[i - 1].y, levels[i].y),
      );
      if (bottom <= top) continue;
      ctx.fillStyle = levels[i].color;
      ctx.fillRect(left, top, right - left, bottom - top);
    }
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = dark ? '#94a3b8' : '#64748b';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();

  ctx.setLineDash(preview ? [5, 4] : []);
  ctx.lineWidth = selected ? 1.5 : 1;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lastLabel = -Infinity;
  for (const level of [...levels].sort((a, b) => a.y - b.y)) {
    if (level.y < 0 || level.y > size.height) continue;
    ctx.strokeStyle = level.color;
    ctx.beginPath();
    ctx.moveTo(left, level.y);
    ctx.lineTo(right, level.y);
    ctx.stroke();
    const y = Math.max(10, level.y - 9);
    if (y - lastLabel < 16) continue;
    lastLabel = y;
    const ratio = (level.ratio * 100).toFixed(1).replace(/\.0$/, '');
    const text = `${ratio}% (${format(level.price)})`;
    const labelWidth = ctx.measureText(text).width;
    const x = Math.max(6, Math.min(left + 6, size.width - labelWidth - 6));
    ctx.fillStyle = dark ? '#0f172a' : '#ffffff';
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x - 3, y - 7, labelWidth + 6, 14);
    ctx.globalAlpha = 1;
    ctx.fillStyle = level.color;
    ctx.fillText(text, x, y);
  }
  if (selected) {
    ctx.setLineDash([]);
    ctx.fillStyle = dark ? '#60a5fa' : '#2563eb';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    for (const point of [start, end]) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
