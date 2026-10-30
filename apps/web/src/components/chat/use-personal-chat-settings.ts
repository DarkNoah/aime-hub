import { createContext, useContext, useSyncExternalStore } from 'react';
import { localAgentMatchesScope } from '@aime/shared/agents';
import type { createChatPreferencesResource } from './preferences-resource';

export const PersonalChatSettingsContext = createContext<ReturnType<
  typeof createChatPreferencesResource
> | null>(null);

export function usePersonalChatSettings(projectId?: string) {
  const resource = useContext(PersonalChatSettingsContext);
  if (!resource) throw new Error('PersonalChatSettingsProvider is required');
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  const settings = localAgentMatchesScope(snapshot.settings.agentId, projectId)
    ? snapshot.settings
    : { ...snapshot.settings, agentId: null };
  return { ...snapshot, settings, save: resource.save, retry: resource.load };
}
