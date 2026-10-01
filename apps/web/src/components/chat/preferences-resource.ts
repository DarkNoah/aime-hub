import type { ChatSettings } from '@aime/shared/threads';
import { chatApi, chatErrorKey } from './api.js';

type Snapshot = {
  settings: ChatSettings;
  loading: boolean;
  saving: boolean;
  error: ReturnType<typeof chatErrorKey> | null;
};

// Shared by page and floating panels within the authenticated session.
export function createChatPreferencesResource(
  initialSettings: ChatSettings = { model: null, reasoningEffort: 'auto' },
  api = { read: chatApi.preferences, save: chatApi.savePreferences },
) {
  let saved = initialSettings;
  let snapshot: Snapshot = {
    settings: saved,
    loading: true,
    saving: false,
    error: null,
  };
  let loaded = false;
  let readVersion = 0;
  let revision = 0;
  let cancelledRevision = 0;
  let pendingRead: Promise<void> | undefined;
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  function load() {
    if (loaded) return Promise.resolve();
    if (pendingRead) return pendingRead;
    const version = ++readVersion;
    publish({ ...snapshot, loading: true, error: null });
    pendingRead = (async () => {
      try {
        const value = await api.read();
        if (version !== readVersion) return;
        saved = value;
        loaded = true;
        publish({
          settings: value,
          loading: false,
          saving: false,
          error: null,
        });
      } catch (cause) {
        if (version === readVersion)
          publish({ ...snapshot, loading: false, error: chatErrorKey(cause) });
      } finally {
        if (version === readVersion) pendingRead = undefined;
      }
    })();
    return pendingRead;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    save(settings: ChatSettings): Promise<boolean> {
      if (
        settings.model === snapshot.settings.model &&
        settings.reasoningEffort === snapshot.settings.reasoningEffort
      )
        return Promise.resolve(false);
      const version = ++revision;
      publish({ ...snapshot, settings, saving: true });
      // Serialize writes: aborting HTTP would not undo a database write already in flight.
      const request = writes.then(async () => {
        if (version <= cancelledRevision) return false;
        try {
          saved = await api.save(settings);
          if (version !== revision) return false;
          publish({ ...snapshot, settings: saved, saving: false });
          return true;
        } catch (cause) {
          if (version !== revision) return false;
          publish({ ...snapshot, settings: saved, saving: false });
          throw cause;
        }
      });
      writes = request.then(
        () => {},
        () => {},
      );
      return request;
    },
    cancel() {
      readVersion++;
      pendingRead = undefined;
      cancelledRevision = revision++;
    },
  };
}
