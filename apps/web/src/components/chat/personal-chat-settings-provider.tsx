import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { ChatSettings } from '@aime/shared/threads';
import { useAuthSession } from '@/features/auth/session-context';
import { createChatPreferencesResource } from './preferences-resource';
import { PersonalChatSettingsContext } from './use-personal-chat-settings';

type Props = { children: ReactNode; initialSettings?: ChatSettings };

export function PersonalChatSettingsProvider(props: Props) {
  const inherited = useContext(PersonalChatSettingsContext);
  const { data } = useAuthSession();
  if (inherited) return props.children;
  return <SettingsSession key={data?.session.id} {...props} />;
}

function SettingsSession({ children, initialSettings }: Props) {
  const [resource] = useState(() =>
    createChatPreferencesResource(initialSettings),
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
