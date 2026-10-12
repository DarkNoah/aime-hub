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
      personal={inherited}
      {...props}
    />
  );
}

function SettingsSession({
  children,
  initialSettings,
  projectId,
  personal,
}: Props & {
  personal: ReturnType<typeof createChatPreferencesResource> | null;
}) {
  async function readPersonal() {
    if (!personal) return chatApi.preferences();
    await personal.load();
    return personal.getSnapshot().settings;
  }
  const [resource] = useState(() =>
    createChatPreferencesResource(
      initialSettings,
      projectId
        ? {
            read: async () => {
              const [project, personal] = await Promise.all([
                chatApi.projectPreferences(projectId),
                readPersonal(),
              ]);
              return { ...project, agentId: personal.agentId ?? null };
            },
            // A member's current chat selection is local; shared defaults are edited in project settings.
            save: async (settings) => {
              const previous = await readPersonal();
              if ((previous.agentId ?? null) !== (settings.agentId ?? null))
                await (personal ? personal.save : chatApi.savePreferences)({
                  ...previous,
                  agentId: settings.agentId ?? null,
                });
              return settings;
            },
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
