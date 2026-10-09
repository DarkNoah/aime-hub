import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { GripHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  adjustWindow,
  fitWindow,
  initialWindow,
  type ResizeDirection,
  type WindowOperation,
  type WindowRect,
} from './geometry';

const handles: Record<ResizeDirection, string> = {
  n: 'inset-x-3 -top-1 h-2 cursor-ns-resize',
  s: 'inset-x-3 -bottom-1 h-2 cursor-ns-resize',
  e: 'inset-y-3 -right-1 w-2 cursor-ew-resize',
  w: 'inset-y-3 -left-1 w-2 cursor-ew-resize',
  ne: '-top-1 -right-1 size-4 cursor-nesw-resize',
  nw: '-top-1 -left-1 size-4 cursor-nwse-resize',
  se: '-bottom-1 -right-1 size-4 cursor-nwse-resize',
  sw: '-bottom-1 -left-1 size-4 cursor-nesw-resize',
};

/** Always keep the content mounted; pointer movement only updates window geometry. */
export function FloatingWindow({
  active,
  boundaryRef,
  title,
  moveLabel,
  resizeLabel,
  actions,
  children,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & {
  active: boolean;
  boundaryRef: RefObject<HTMLElement | null>;
  title: string;
  moveLabel: string;
  resizeLabel: (direction: ResizeDirection) => string;
  actions?: ReactNode;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<WindowRect | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    rect: WindowRect;
    operation: WindowOperation;
  } | null>(null);

  function bounds() {
    return {
      width: boundaryRef.current?.clientWidth ?? 0,
      height: boundaryRef.current?.clientHeight ?? 0,
    };
  }

  function paint(rect: WindowRect) {
    rectRef.current = rect;
    windowRef.current?.style.setProperty('--window-x', `${rect.x}px`);
    windowRef.current?.style.setProperty('--window-y', `${rect.y}px`);
    windowRef.current?.style.setProperty('--window-width', `${rect.width}px`);
    windowRef.current?.style.setProperty('--window-height', `${rect.height}px`);
  }

  useLayoutEffect(() => {
    if (!active || !boundaryRef.current) return;
    const boundary = boundaryRef.current;
    const fit = () => {
      const size = {
        width: boundary.clientWidth,
        height: boundary.clientHeight,
      };
      paint(
        rectRef.current
          ? fitWindow(rectRef.current, size)
          : initialWindow(size),
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(boundary);
    return () => {
      observer.disconnect();
      gestureRef.current = null;
    };
  }, [active, boundaryRef]);

  function start(event: PointerEvent<HTMLElement>, operation: WindowOperation) {
    if (event.button !== 0 || !event.isPrimary || !rectRef.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      rect: rectRef.current,
      operation,
    };
  }

  function move(event: PointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    paint(
      adjustWindow(
        gesture.rect,
        gesture.operation,
        event.clientX - gesture.x,
        event.clientY - gesture.y,
        bounds(),
      ),
    );
  }

  function end(event: PointerEvent<HTMLElement>) {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function key(event: KeyboardEvent<HTMLElement>, operation: WindowOperation) {
    if (
      !rectRef.current ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return;
    event.preventDefault();
    const step = event.shiftKey ? 24 : 8;
    const dx =
      event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy =
      event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    paint(adjustWindow(rectRef.current, operation, dx, dy, bounds()));
  }

  function resizeStart(event: PointerEvent<HTMLButtonElement>) {
    start(
      event,
      event.currentTarget.dataset.resizeDirection as ResizeDirection,
    );
  }

  function resizeKey(event: KeyboardEvent<HTMLButtonElement>) {
    key(event, event.currentTarget.dataset.resizeDirection as ResizeDirection);
  }

  const gestureEvents = {
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };

  return (
    <div
      ref={windowRef}
      className={cn(
        'min-h-0 min-w-0 bg-card',
        active
          ? 'absolute top-0 left-0 z-20 h-[var(--window-height)] w-[var(--window-width)] translate-x-[var(--window-x)] translate-y-[var(--window-y)] rounded-xl shadow-sm ring-1 ring-border'
          : 'h-full w-full',
        className,
      )}
      {...props}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[inherit]">
        {active && (
          <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/40 px-2">
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 touch-none items-center gap-1.5 rounded-sm text-left text-xs font-medium select-none focus-visible:outline-2 focus-visible:outline-ring [&&]:cursor-grab [&&]:active:cursor-grabbing"
              aria-label={moveLabel}
              title={moveLabel}
              onPointerDown={(event) => start(event, 'move')}
              onKeyDown={(event) => key(event, 'move')}
              {...gestureEvents}
            >
              <GripHorizontal
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">{title}</span>
            </button>
            {actions}
          </div>
        )}
        {children}
      </div>
      {active &&
        (Object.keys(handles) as ResizeDirection[]).map((direction) => (
          <button
            key={direction}
            type="button"
            data-resize-direction={direction}
            aria-label={resizeLabel(direction)}
            title={resizeLabel(direction)}
            className={cn(
              'absolute z-10 touch-none rounded-sm select-none focus-visible:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring',
              handles[direction],
            )}
            onPointerDown={resizeStart}
            onKeyDown={resizeKey}
            {...gestureEvents}
          >
            {direction === 'se' && (
              <svg
                viewBox="0 0 12 12"
                className="size-3 text-muted-foreground"
                aria-hidden="true"
              >
                <path
                  d="M4 9 9 4M8 9l1-1"
                  stroke="currentColor"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        ))}
    </div>
  );
}
