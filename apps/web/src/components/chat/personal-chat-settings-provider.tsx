import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { ChatSettings } from '@aime/shared/threads';
import { useAuthSession } from '@/features/auth/session-context';
import { createChatPreferencesResource } from './preferences-resource';
import { PersonalChatSettingsContext } from './use-personal-chat-settings';
import { chatApi } from './api';

type Props = {
  children: ReactNode;
  initialSettings?: ChatSettings;
  projectId?: string;
};

export function PersonalChatSettingsProvider(props: Props) {
  const inherited = useContext(PersonalChatSettingsContext);
  const { data } = useAuthSession();
  if (inherited && !props.projectId) return props.children;
  return (
    <SettingsSession
      key={`${data?.session.id}:${props.projectId ?? 'personal'}`}
      {...props}
    />
  );
}

function SettingsSession({ children, initialSettings, projectId }: Props) {
  const [resource] = useState(() =>
    createChatPreferencesResource(
      initialSettings,
      projectId
        ? {
            read: () => chatApi.projectPreferences(projectId),
            // A member's current chat selection is local; shared defaults are edited in project settings.
            save: async (settings) => settings,
          }
        : undefined,
    ),
  );
  useEffect(() => {
    void resource.load();
    return () => resource.cancel();
  }, [resource]);
  return (
    <PersonalChatSettingsContext.Provider value={resource}>
      {children}
    </PersonalChatSettingsContext.Provider>
  );
}
