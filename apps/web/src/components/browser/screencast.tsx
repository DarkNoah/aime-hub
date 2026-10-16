import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { Globe2, LoaderCircle, MousePointer2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BrowserAction, BrowserFrame } from '@aime/shared/browser';
import { cn } from '@/lib/utils';
import type { BrowserResource } from './resource';
import { browserModifiers, browserPoint } from './coordinates';

export function BrowserScreencast({
  resource,
  interactive = false,
  onError,
  className,
}: {
  resource: BrowserResource;
  interactive?: boolean;
  onError?: (error: unknown) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<BrowserFrame['viewport'] | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const composing = useRef(false);
  const committed = useRef('');
  const pressedKeys = useRef(
    new Map<string, Extract<BrowserAction, { kind: 'keyboard' }>['event']>(),
  );
  const pressedMouse = useRef<
    Extract<BrowserAction, { kind: 'mouse' }>['event'] | null
  >(null);
  const latestMove = useRef<BrowserAction | null>(null);
  const lastClick = useRef({ at: 0, x: 0, y: 0, button: -1, count: 0 });
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorRef = useRef(onError);
  const enabled =
    interactive &&
    hasFrame &&
    state.connection === 'connected' &&
    state.status === 'ready' &&
    !state.busy;
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    errorRef.current = onError;
    enabledRef.current = enabled;
  }, [onError, enabled]);

  function send(action: BrowserAction) {
    void resource
      .action(action)
      .catch((error: unknown) => errorRef.current?.(error));
  }

  useEffect(() => {
    let disposed = false;
    let decoding = false;
    let pending: BrowserFrame | null = null;
    let generation = 0;
    function paint(frame: BrowserFrame) {
      decoding = true;
      const version = generation;
      const image = new Image();
      image.onload = () => {
        if (!disposed && version === generation) {
          const node = canvas.current;
          const context = node?.getContext('2d');
          if (node && context) {
            node.width = image.naturalWidth;
            node.height = image.naturalHeight;
            context.drawImage(image, 0, 0);
            viewport.current = frame.viewport;
            setHasFrame(true);
          }
        }
        finish();
      };
      image.onerror = finish;
      image.src = `data:image/jpeg;base64,${frame.data}`;
    }
    function finish() {
      decoding = false;
      const next = pending;
      pending = null;
      if (next && !disposed) paint(next);
    }
    const stop = resource.subscribeFrames((frame) => {
      if (!frame) {
        generation += 1;
        pending = null;
        viewport.current = null;
        setHasFrame(false);
        return;
      }
      if (decoding) pending = frame;
      else paint(frame);
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [resource]);

  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    let pending: Extract<BrowserAction, { kind: 'mouse' }>['event'] | null =
      null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => {
      if (!enabledRef.current || !viewport.current) return;
      const point = browserPoint(
        node.getBoundingClientRect(),
        viewport.current,
        event.clientX,
        event.clientY,
      );
      if (!point) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewport.current.height
            : 1;
      pending = {
        type: 'mouseWheel',
        ...point,
        deltaX: Math.max(
          -10000,
          Math.min(10000, (pending?.deltaX ?? 0) + event.deltaX * unit),
        ),
        deltaY: Math.max(
          -10000,
          Math.min(10000, (pending?.deltaY ?? 0) + event.deltaY * unit),
        ),
        modifiers: browserModifiers(event),
      };
      timer ??= setTimeout(() => {
        timer = undefined;
        const next = pending;
        pending = null;
        if (next && enabledRef.current)
          void resource
            .action({ kind: 'mouse', event: next })
            .catch((error: unknown) => errorRef.current?.(error));
      }, 40);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => {
      clearTimeout(timer);
      node.removeEventListener('wheel', wheel);
    };
  }, [resource]);

  useEffect(() => {
    if (enabled) return;
    input.current?.blur();
    if (pressedMouse.current) {
      void resource
        .action({
          kind: 'mouse',
          event: { ...pressedMouse.current, type: 'mouseReleased' },
        })
        .catch(() => {});
      pressedMouse.current = null;
    }
    for (const event of pressedKeys.current.values())
      void resource
        .action({ kind: 'keyboard', event: { ...event, type: 'keyUp' } })
        .catch(() => {});
    pressedKeys.current.clear();
  }, [enabled, resource]);

  useEffect(
    () => () => {
      if (moveTimer.current) clearTimeout(moveTimer.current);
      if (pressedMouse.current)
        void resource
          .action({
            kind: 'mouse',
            event: { ...pressedMouse.current, type: 'mouseReleased' },
          })
          .catch(() => {});
      for (const event of pressedKeys.current.values())
        void resource
          .action({ kind: 'keyboard', event: { ...event, type: 'keyUp' } })
          .catch(() => {});
    },
    [resource],
  );

  function pointer(
    event: PointerEvent<HTMLCanvasElement>,
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
  ) {
    if ((!enabled && type !== 'mouseReleased') || !viewport.current) return;
    const point = browserPoint(
      event.currentTarget.getBoundingClientRect(),
      viewport.current,
      event.clientX,
      event.clientY,
      type === 'mouseReleased' || !!pressedMouse.current,
    );
    if (!point) return;
    const button =
      event.button === 2
        ? 'right'
        : event.button === 1
          ? 'middle'
          : type === 'mouseMoved' && !event.buttons
            ? 'none'
            : 'left';
    if (type === 'mousePressed') {
      const previous = lastClick.current;
      const now = Date.now();
      const repeated =
        now - previous.at < 500 &&
        previous.button === event.button &&
        Math.hypot(previous.x - event.clientX, previous.y - event.clientY) < 5;
      lastClick.current = {
        at: now,
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        count: repeated ? (previous.count % 3) + 1 : 1,
      };
    }
    const action: BrowserAction = {
      kind: 'mouse',
      event: {
        type,
        ...point,
        button,
        clickCount: type === 'mouseMoved' ? 0 : lastClick.current.count,
        modifiers: browserModifiers(event),
      },
    };
    if (type === 'mouseMoved') {
      latestMove.current = action;
      moveTimer.current ??= setTimeout(() => {
        moveTimer.current = null;
        if (latestMove.current && enabledRef.current) send(latestMove.current);
        latestMove.current = null;
      }, 50);
      return;
    }
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = null;
    latestMove.current = null;
    event.preventDefault();
    if (type === 'mousePressed') {
      input.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      pressedMouse.current = action.event;
    } else {
      if (!pressedMouse.current) return;
      pressedMouse.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }
    send(action);
  }

  function keyboard(
    event: KeyboardEvent<HTMLTextAreaElement>,
    type: 'keyDown' | 'keyUp',
  ) {
    if (
      !enabled ||
      composing.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    if (type === 'keyDown') {
      committed.current = '';
      // Let the local textarea produce text, IME and clipboard events.
      if (
        (event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey) ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v')
      )
        return;
      event.preventDefault();
      const value = {
        type,
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        modifiers: browserModifiers(event),
      };
      pressedKeys.current.set(event.code, value);
      send({ kind: 'keyboard', event: value });
      if (event.key === 'Escape') input.current?.blur();
    } else {
      const value = pressedKeys.current.get(event.code);
      if (!value) return;
      event.preventDefault();
      pressedKeys.current.delete(event.code);
      send({ kind: 'keyboard', event: { ...value, type } });
    }
  }

  function insert(text: string) {
    if (text.length > 10000) {
      errorRef.current?.({ code: 'BROWSER_TEXT_TOO_LONG' });
      return;
    }
    if (text && enabledRef.current) send({ kind: 'text', text });
  }
  const message =
    state.connection === 'forbidden'
      ? 'browser.forbidden'
      : state.connection === 'disconnected'
        ? 'browser.reconnecting'
        : state.connection === 'connecting'
          ? 'browser.connecting'
          : state.status === 'error'
            ? 'browser.streamFailed'
            : state.status === 'closed'
              ? 'browser.closedHint'
              : state.status === 'waiting'
                ? 'browser.waitingHint'
                : 'browser.loading';
  return (
    <div
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-muted/30',
        className,
      )}
    >
      <canvas
        ref={canvas}
        className={cn(
          'size-full object-contain',
          enabled ? 'touch-none cursor-default' : 'pointer-events-none',
          !hasFrame && 'invisible',
        )}
        aria-label={t('browser.screen')}
        onPointerDown={(event) => pointer(event, 'mousePressed')}
        onPointerUp={(event) => pointer(event, 'mouseReleased')}
        onPointerMove={(event) => pointer(event, 'mouseMoved')}
        onPointerCancel={(event) => pointer(event, 'mouseReleased')}
        onContextMenu={(event) => {
          if (enabled) event.preventDefault();
        }}
      />
      <textarea
        ref={input}
        tabIndex={enabled ? 0 : -1}
        disabled={!enabled}
        className="absolute bottom-0 left-0 size-px resize-none opacity-0"
        aria-label={t('browser.keyboardHint')}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(event) => keyboard(event, 'keyDown')}
        onKeyUp={(event) => keyboard(event, 'keyUp')}
        onCompositionStart={() => {
          composing.current = true;
          committed.current = '';
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          committed.current = event.data;
          insert(event.data);
          event.currentTarget.value = '';
        }}
        onInput={(event) => {
          if (
            composing.current ||
            (event.nativeEvent as InputEvent).isComposing
          )
            return;
          const value = event.currentTarget.value;
          event.currentTarget.value = '';
          if (value !== committed.current) insert(value);
          committed.current = '';
        }}
        onPaste={(event) => {
          event.preventDefault();
          insert(event.clipboardData.getData('text/plain'));
        }}
        onBlur={() => {
          for (const value of pressedKeys.current.values())
            send({ kind: 'keyboard', event: { ...value, type: 'keyUp' } });
          pressedKeys.current.clear();
        }}
      />
      {!hasFrame && (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground"
        >
          {state.status === 'ready' || state.connection === 'connecting' ? (
            <LoaderCircle
              className="size-6 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <Globe2 className="size-7" aria-hidden />
          )}
          <p className="max-w-64 leading-relaxed">{t(message)}</p>
        </div>
      )}
      {enabled && (
        <span className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1 rounded bg-background/95 px-2 py-1 text-[10px] text-muted-foreground ring-1 ring-border">
          <MousePointer2 className="size-3" />
          {t('browser.interactive')}
        </span>
      )}
    </div>
  );
}
