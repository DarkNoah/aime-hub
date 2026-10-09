export type WindowBounds = { width: number; height: number };
export type WindowRect = WindowBounds & { x: number; y: number };
export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type WindowOperation = 'move' | ResizeDirection;

const MIN_WIDTH = 320;
const MIN_HEIGHT = 320;
const INSET = 8;
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

function limits(bounds: WindowBounds) {
  const inset = Math.min(INSET, bounds.width / 2, bounds.height / 2);
  return {
    inset,
    right: bounds.width - inset,
    bottom: bounds.height - inset,
    minWidth: Math.min(MIN_WIDTH, bounds.width - inset * 2),
    minHeight: Math.min(MIN_HEIGHT, bounds.height - inset * 2),
  };
}

export function fitWindow(rect: WindowRect, bounds: WindowBounds): WindowRect {
  const { inset, right, bottom, minWidth, minHeight } = limits(bounds);
  const width = clamp(rect.width, minWidth, right - inset);
  const height = clamp(rect.height, minHeight, bottom - inset);
  return {
    x: clamp(rect.x, inset, right - width),
    y: clamp(rect.y, inset, bottom - height),
    width,
    height,
  };
}

export function initialWindow(bounds: WindowBounds): WindowRect {
  return fitWindow(
    { x: 16, y: bounds.height - 536, width: 384, height: 520 },
    bounds,
  );
}

export function adjustWindow(
  rect: WindowRect,
  operation: WindowOperation,
  dx: number,
  dy: number,
  bounds: WindowBounds,
): WindowRect {
  const start = fitWindow(rect, bounds);
  if (operation === 'move') {
    return fitWindow({ ...start, x: start.x + dx, y: start.y + dy }, bounds);
  }
  const { inset, right, bottom, minWidth, minHeight } = limits(bounds);
  let left = start.x;
  let top = start.y;
  let endX = left + start.width;
  let endY = top + start.height;
  if (operation.includes('w')) left = clamp(left + dx, inset, endX - minWidth);
  if (operation.includes('e')) endX = clamp(endX + dx, left + minWidth, right);
  if (operation.includes('n')) top = clamp(top + dy, inset, endY - minHeight);
  if (operation.includes('s')) endY = clamp(endY + dy, top + minHeight, bottom);
  return { x: left, y: top, width: endX - left, height: endY - top };
}
