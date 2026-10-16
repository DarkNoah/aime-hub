import {
  emptyBrowserState,
  type BrowserAction,
  type BrowserFrame,
  type BrowserState,
} from '@aime/shared/browser';
import { api, apiErrorCode } from '@/lib/rpc';

export type BrowserViewState = BrowserState & {
  connection: 'connecting' | 'connected' | 'disconnected' | 'forbidden';
};

/** The dock and sidebar share one SSE connection and one ordered input queue. */
export function createBrowserResource(threadId: string) {
  let state: BrowserViewState = {
    ...emptyBrowserState,
    connection: 'connecting',
  };
  const listeners = new Set<() => void>();
  const frames = new Set<(frame: BrowserFrame | null) => void>();
  let lastFrame: BrowserFrame | null = null;
  let source: EventSource | undefined;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let input: Promise<unknown> = Promise.resolve();
  let queued = 0;

  function update(next: BrowserViewState) {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    if (state.status !== 'ready' || state.connection !== 'connected') {
      lastFrame = null;
      for (const listener of frames) listener(null);
    }
    for (const listener of listeners) listener();
  }
  function connect() {
    controller = new AbortController();
    const signal = controller.signal;
    update({ ...state, connection: 'connecting' });
    void api.threads.browser
      .state({ params: { threadId } }, { signal })
      .then((initial) => {
        if (signal.aborted) return;
        update({ ...initial, connection: 'connecting' });
        source = new EventSource(
          `/api/threads/${encodeURIComponent(threadId)}/browser/events`,
        );
        source.addEventListener('state', (event) => {
          if (signal.aborted) return;
          update({
            ...(JSON.parse((event as MessageEvent).data) as BrowserState),
            connection: 'connected',
          });
        });
        source.addEventListener('frame', (event) => {
          if (signal.aborted) return;
          lastFrame = JSON.parse((event as MessageEvent).data) as BrowserFrame;
          for (const listener of frames) listener(lastFrame);
        });
        source.onerror = () => {
          if (signal.aborted) return;
          source?.close();
          update({ ...state, connection: 'disconnected' });
          retry = setTimeout(connect, 3000);
        };
        const revoked = () => {
          source?.close();
          update({ ...emptyBrowserState, connection: 'forbidden' });
        };
        source.addEventListener('revoked', revoked);
        source.addEventListener('expired', revoked);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        const forbidden = [
          'UNAUTHORIZED',
          'FORBIDDEN',
          'THREAD_NOT_FOUND',
          'PROJECT_NOT_FOUND',
        ].includes(apiErrorCode(error) ?? '');
        update({
          ...emptyBrowserState,
          connection: forbidden ? 'forbidden' : 'disconnected',
        });
        if (!forbidden) retry = setTimeout(connect, 3000);
      });
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        controller?.abort();
        clearTimeout(retry);
        source?.close();
        lastFrame = null;
        state = { ...emptyBrowserState, connection: 'connecting' };
      };
    },
    subscribeFrames(listener: (frame: BrowserFrame | null) => void) {
      frames.add(listener);
      if (lastFrame) listener(lastFrame);
      return () => {
        frames.delete(listener);
      };
    },
    action(action: BrowserAction) {
      if (queued >= 64)
        return Promise.reject(new Error('BROWSER_INPUT_QUEUE_FULL'));
      queued += 1;
      const next = input
        .catch(() => {})
        .then(() =>
          api.threads.browser.action({ params: { threadId }, body: action }),
        );
      input = next;
      return next.finally(() => {
        queued -= 1;
      });
    },
  };
}
export type BrowserResource = ReturnType<typeof createBrowserResource>;
const resources = new Map<string, BrowserResource>();
export function getBrowserResource(threadId: string) {
  let resource = resources.get(threadId);
  if (!resource)
    resources.set(threadId, (resource = createBrowserResource(threadId)));
  return resource;
}

export function browserErrorKey(error: unknown) {
  const code = apiErrorCode(error);
  if (code === 'BROWSER_TEXT_TOO_LONG') return 'browser.textTooLong';
  if (code === 'BROWSER_BUSY') return 'browser.busyHint';
  if (code === 'BROWSER_NOT_RUNNING') return 'browser.waitingHint';
  if (
    [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'THREAD_NOT_FOUND',
      'PROJECT_NOT_FOUND',
    ].includes(code ?? '')
  )
    return 'browser.forbidden';
  return 'browser.actionFailed';
}
