import { api, apiErrorCode } from '../../lib/rpc.js';
import type { AvailableModels } from '@aime/shared/providers';

export type ModelsError =
  'errors.network' | 'errors.sessionExpired' | 'errors.server';
type Snapshot = AvailableModels & { loading: boolean; error?: ModelsError };
const invalidationListeners = new Set<() => void>();

export function invalidateAvailableModels() {
  invalidationListeners.forEach((listener) => listener());
}

export function onModelsInvalidated(listener: () => void) {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

// Each authenticated session owns its cache. All hook consumers share it.
export function createModelsResource() {
  let snapshot: Snapshot = { providers: [], loading: true };
  let pending: Promise<void> | undefined;
  let version = 0;
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();
  function publish(next: Snapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
  function refresh(force = false): Promise<void> {
    if (pending && !force) return pending;
    const requestVersion = ++version;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    publish({ ...snapshot, loading: true, error: undefined });
    pending = (async () => {
      try {
        const data = await api.providers.available(undefined, { signal });
        if (requestVersion === version) publish({ ...data, loading: false });
      } catch (error) {
        if (requestVersion === version)
          publish({
            ...snapshot,
            ...(apiErrorCode(error) === 'UNAUTHORIZED'
              ? { providers: [] }
              : {}),
            loading: false,
            error:
              apiErrorCode(error) === 'UNAUTHORIZED'
                ? 'errors.sessionExpired'
                : error instanceof TypeError
                  ? 'errors.network'
                  : 'errors.server',
          });
      } finally {
        if (requestVersion === version) pending = undefined;
      }
    })();
    return pending;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
  };
}
