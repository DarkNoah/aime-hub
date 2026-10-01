import { createContext, useContext, useSyncExternalStore } from 'react';
import type { createChatPreferencesResource } from './preferences-resource';

export const PersonalChatSettingsContext = createContext<ReturnType<
  typeof createChatPreferencesResource
> | null>(null);

export function usePersonalChatSettings() {
  const resource = useContext(PersonalChatSettingsContext);
  if (!resource) throw new Error('PersonalChatSettingsProvider is required');
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  return { ...snapshot, save: resource.save, retry: resource.load };
}
