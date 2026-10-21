import {
  positionRatio,
  segmentDistance,
  type DrawingPart,
  type Point,
  type PositionDrawing,
} from './model';

export interface PositionGeometry {
  start: number;
  end: number;
  entry: number;
  target: number;
  stop: number;
}

export function positionHandles(
  geometry: PositionGeometry,
): { part: DrawingPart; point: Point }[] {
  const center = (geometry.start + geometry.end) / 2;
  return [
    { part: 'start', point: { x: geometry.start, y: geometry.entry } },
    { part: 'end', point: { x: geometry.end, y: geometry.entry } },
    ...(['target', 'stop', 'entry'] as const).map((part) => ({
      part,
      point: { x: center, y: geometry[part] },
    })),
  ];
}

export function hitPosition(
  point: Point,
  geometry: PositionGeometry,
  selected: boolean,
): DrawingPart | null {
  if (selected) {
    for (const handle of positionHandles(geometry)) {
      if (Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= 9)
        return handle.part;
    }
  }
  // Exit boundaries are directly draggable, including before selection.
  const levels = selected
    ? (['target', 'stop', 'entry'] as const)
    : (['target', 'stop'] as const);
  let closest: DrawingPart | null = null;
  let distance = 8;
  for (const part of levels) {
    const next = segmentDistance(
      point,
      { x: geometry.start, y: geometry[part] },
      { x: geometry.end, y: geometry[part] },
    );
    if (next <= distance) {
      closest = part;
      distance = next;
    }
  }
  if (closest) return closest;
  return point.x >= Math.min(geometry.start, geometry.end) - 4 &&
    point.x <= Math.max(geometry.start, geometry.end) + 4 &&
    point.y >= Math.min(geometry.target, geometry.stop) - 4 &&
    point.y <= Math.max(geometry.target, geometry.stop) + 4
    ? 'line'
    : null;
}

export function drawPosition(
  ctx: CanvasRenderingContext2D,
  geometry: PositionGeometry,
  drawing: PositionDrawing,
  selected: boolean,
  preview: boolean,
  size: { width: number; height: number },
  format: (price: number) => string,
) {
  const left = Math.min(geometry.start, geometry.end),
    width = Math.abs(geometry.end - geometry.start);
  const mainColor = drawing.side === 'long' ? '#dc4c5c' : '#16a085';
  const colors = {
    target: mainColor,
    stop: drawing.side === 'long' ? '#16a085' : '#dc4c5c',
    entry: mainColor,
  };
  ctx.save();
  ctx.setLineDash(preview ? [5, 4] : []);
  for (const part of ['target', 'stop'] as const) {
    const top = Math.min(geometry.entry, geometry[part]),
      height = Math.abs(geometry.entry - geometry[part]);
    ctx.fillStyle = colors[part];
    ctx.globalAlpha = selected ? 0.22 : 0.16;
    ctx.fillRect(left, top, width, height);
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = colors[part];
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, width, height);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors.entry;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(geometry.start, geometry.entry);
  ctx.lineTo(geometry.end, geometry.entry);
  ctx.stroke();
  if (selected) {
    ctx.setLineDash([]);
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const center = (geometry.start + geometry.end) / 2;
    const label = (part: 'target' | 'stop' | 'entry', text: string) => {
      const labelWidth = ctx.measureText(text).width + 14;
      const x = Math.max(
        labelWidth / 2 + 4,
        Math.min(size.width - labelWidth / 2 - 4, center),
      );
      const offset =
        part === 'entry' || geometry[part] < geometry.entry ? -16 : 16;
      const y = Math.max(
        12,
        Math.min(size.height - 12, geometry[part] + offset),
      );
      ctx.fillStyle = colors[part];
      ctx.fillRect(x - labelWidth / 2, y - 10, labelWidth, 20);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, x, y);
    };
    label('target', `止盈 ${format(drawing.target)}`);
    label('stop', `止损 ${format(drawing.stop)}`);
    label(
      'entry',
      `${drawing.side === 'long' ? '多头' : '空头'} ${format(drawing.entry)} · ${positionRatio(drawing).toFixed(2)}:1`,
    );
    // Resize handles sit above the labels so all five controls remain visible.
    for (const { point } of positionHandles(geometry)) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = mainColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
