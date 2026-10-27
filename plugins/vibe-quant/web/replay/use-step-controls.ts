import {
  useEffect,
  useMemo,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { createReplayStepHold, type ReplayStepDirection } from './step-hold';

function isEditing(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"]',
    )
  );
}

export function useReplayStepControls({
  enabled,
  sessionId,
  speed,
  step,
  scope,
}: {
  enabled: boolean;
  sessionId?: number;
  speed: number;
  step: (direction: ReplayStepDirection) => void;
  scope: RefObject<HTMLDivElement | null>;
}) {
  const hold = useMemo(() => createReplayStepHold(step, speed), [step, speed]);
  useEffect(() => {
    if (!enabled) return;
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditing(event.target) ||
        !scope.current?.contains(event.target as Node)
      )
        return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      if (!event.repeat)
        hold.start(`key:${event.key}`, event.key === 'ArrowLeft' ? -1 : 1);
    };
    const keyUp = (event: KeyboardEvent) => hold.stop(`key:${event.key}`);
    const pointerUp = (event: globalThis.PointerEvent) =>
      hold.stop(`pointer:${event.pointerId}`);
    const stop = () => hold.stop();
    const visibility = () => {
      if (document.hidden) stop();
    };
    const focus = (event: FocusEvent) => {
      if (
        isEditing(event.target) ||
        !scope.current?.contains(event.target as Node)
      )
        stop();
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('pointercancel', pointerUp, true);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('focusin', focus);
    return () => {
      stop();
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('pointercancel', pointerUp, true);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('focusin', focus);
    };
  }, [enabled, hold, sessionId, scope]);

  function buttonProps(direction: ReplayStepDirection) {
    return {
      onContextMenu(event: MouseEvent<HTMLButtonElement>) {
        event.preventDefault();
      },
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (!enabled || event.button !== 0 || !event.isPrimary) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        hold.start(`pointer:${event.pointerId}`, direction);
      },
      onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) {
        hold.stop(`pointer:${event.pointerId}`);
      },
      onClick(event: MouseEvent<HTMLButtonElement>) {
        if (enabled && event.detail === 0) step(direction);
      },
    };
  }
  return { buttonProps };
}
