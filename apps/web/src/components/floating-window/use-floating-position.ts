import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { readWindowRect, saveWindowRect } from './storage';

/** Move a content-sized floating surface without rerendering its live preview. */
export function useFloatingPosition(storageKey: string, active: boolean) {
  const containerRef = useRef<HTMLElement>(null);
  const position = useRef<{ x: number; y: number } | null>(null);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  function paint(x: number, y: number) {
    const node = containerRef.current;
    if (!node) return;
    const inset = 8;
    const next = {
      x: Math.max(
        inset,
        Math.min(
          x,
          document.documentElement.clientWidth - node.offsetWidth - inset,
        ),
      ),
      y: Math.max(
        inset,
        Math.min(
          y,
          document.documentElement.clientHeight -
            node.offsetHeight -
            inset -
            12,
        ),
      ),
    };
    position.current = next;
    node.style.left = `${next.x}px`;
    node.style.top = `${next.y}px`;
    node.style.right = 'auto';
  }
  function save() {
    const node = containerRef.current;
    if (node && position.current)
      saveWindowRect(storageKey, {
        ...position.current,
        width: node.offsetWidth,
        height: node.offsetHeight,
      });
  }
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!active || !node) return;
    const stored = readWindowRect(storageKey);
    if (stored) position.current = { x: stored.x, y: stored.y };
    const fit = () => {
      const rect = node.getBoundingClientRect();
      paint(position.current?.x ?? rect.left, position.current?.y ?? rect.top);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      gesture.current = null;
    };
  }, [active, storageKey]);

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary || !containerRef.current) return;
    suppressClick.current = false;
    const rect = containerRef.current.getBoundingClientRect();
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    event.preventDefault();
    paint(current.left + dx, current.top + dy);
  }
  function end(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    suppressClick.current = current.moved;
    if (current.moved) save();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return {
    containerRef,
    moveHandleProps: {
      onPointerDown: start,
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onClickCapture(event: MouseEvent<HTMLButtonElement>) {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        suppressClick.current = false;
        const point = position.current;
        if (
          !point ||
          !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
            event.key,
          )
        )
          return;
        event.preventDefault();
        const step = event.shiftKey ? 24 : 8;
        paint(
          point.x +
            (event.key === 'ArrowLeft'
              ? -step
              : event.key === 'ArrowRight'
                ? step
                : 0),
          point.y +
            (event.key === 'ArrowUp'
              ? -step
              : event.key === 'ArrowDown'
                ? step
                : 0),
        );
        save();
      },
    },
  };
}
