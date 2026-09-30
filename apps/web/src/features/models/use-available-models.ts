import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { createModelsResource } from './resource';

export const AvailableModelsContext = createContext<ReturnType<
  typeof createModelsResource
> | null>(null);

export function useAvailableModels() {
  const resource = useContext(AvailableModelsContext);
  if (!resource)
    throw new Error(
      'useAvailableModels must be used within AvailableModelsProvider',
    );
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
  );
  const models = useMemo(
    () => snapshot.providers.flatMap((provider) => provider.models),
    [snapshot.providers],
  );
  return { ...snapshot, models, refresh: resource.refresh };
}
