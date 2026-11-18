import {
  browserViewportMaxDimension,
  type BrowserFrame,
} from '@aime/shared/browser';
import type { BrowserResource } from './resource';

/** Only the interactive panel supplies a layout size; the dock scales the received frames. */
export function observeBrowserViewport(
  surface: HTMLElement,
  resource: BrowserResource,
  onError: (error: unknown) => void,
) {
  let timer: ReturnType<typeof setTimeout>;
  let request: AbortController | undefined;
  let lastSize: BrowserFrame['viewport'] | undefined;
  let dirty = false;
  let disposed = false;

  async function resize() {
    if (disposed || document.hidden) return;
    if (request) {
      dirty = true;
      return;
    }
    const availableWidth = surface.clientWidth;
    const availableHeight = surface.clientHeight;
    if (!availableWidth || !availableHeight) return;
    const scale = Math.min(
      1,
      browserViewportMaxDimension / Math.max(availableWidth, availableHeight),
    );
    const width = Math.max(1, Math.round(availableWidth * scale));
    const height = Math.max(1, Math.round(availableHeight * scale));
    if (lastSize?.width === width && lastSize.height === height) return;

    const controller = new AbortController();
    request = controller;
    try {
      await resource.action(
        { kind: 'resize', width, height },
        controller.signal,
      );
      if (!controller.signal.aborted) lastSize = { width, height };
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      request = undefined;
      if (dirty) {
        dirty = false;
        schedule();
      }
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!disposed && !document.hidden)
      timer = setTimeout(() => void resize(), 120);
  }
  function visibilityChanged() {
    if (document.hidden) {
      request?.abort();
      lastSize = undefined;
    }
    schedule();
  }

  const observer = new ResizeObserver(schedule);
  observer.observe(surface);
  document.addEventListener('visibilitychange', visibilityChanged);
  return () => {
    disposed = true;
    clearTimeout(timer);
    request?.abort();
    observer.disconnect();
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
}
