/** Map an object-contain surface to browser CSS pixels, excluding the letterbox. */
export function browserPoint(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
  clientX: number,
  clientY: number,
  clamp = false,
) {
  const scale = Math.min(
    rect.width / viewport.width,
    rect.height / viewport.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x =
    (clientX - rect.left - (rect.width - viewport.width * scale) / 2) / scale;
  const y =
    (clientY - rect.top - (rect.height - viewport.height * scale) / 2) / scale;
  if (!clamp && (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height))
    return null;
  return {
    x: Math.max(0, Math.min(viewport.width - 1, x)),
    y: Math.max(0, Math.min(viewport.height - 1, y)),
  };
}

export function browserModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}
