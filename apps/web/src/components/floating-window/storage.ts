import type { WindowRect } from './geometry';

function isWindowRect(value: unknown): value is WindowRect {
  if (!value || typeof value !== 'object') return false;
  return (
    'x' in value &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    'y' in value &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y) &&
    'width' in value &&
    typeof value.width === 'number' &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    'height' in value &&
    typeof value.height === 'number' &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

export function readWindowRect(key: string): WindowRect | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!isWindowRect(value)) return null;
    return {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
    };
  } catch {
    return null;
  }
}

export function saveWindowRect(key: string, rect: WindowRect) {
  if (!isWindowRect(rect)) return;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }),
    );
  } catch {
    // Moving and resizing remain usable when browser storage is unavailable.
  }
}
